import buildModules, { linkBinsOfDependencies } from '@pnpm/build-modules'
import {
  LAYOUT_VERSION,
  LOCKFILE_VERSION,
  WANTED_LOCKFILE,
} from '@pnpm/constants'
import {
  stageLogger,
  summaryLogger,
} from '@pnpm/core-loggers'
import PnpmError from '@pnpm/error'
import getContext, { PnpmContext, ProjectOptions } from '@pnpm/get-context'
import headless from '@pnpm/headless'
import {
  runLifecycleHooksConcurrently,
} from '@pnpm/lifecycle'
import linkBins from '@pnpm/link-bins'
import {
  ProjectSnapshot,
  writeCurrentLockfile,
  writeLockfiles,
  writeWantedLockfile,
} from '@pnpm/lockfile-file'
import logger, { streamParser } from '@pnpm/logger'
import { getAllDependenciesFromManifest } from '@pnpm/manifest-utils'
import { write as writeModulesYaml } from '@pnpm/modules-yaml'
import readModulesDirs from '@pnpm/read-modules-dir'
import { removeBin } from '@pnpm/remove-bins'
import resolveDependencies, {
  DependenciesGraph,
  DependenciesGraphNode,
  ImporterToResolve,
} from '@pnpm/resolve-dependencies'
import {
  PreferredVersions,
  WorkspacePackages,
} from '@pnpm/resolver-base'
import {
  DependenciesField,
  ProjectManifest,
} from '@pnpm/types'
import parseWantedDependencies from '../parseWantedDependencies'
import safeIsInnerLink from '../safeIsInnerLink'
import removeDeps from '../uninstall/removeDeps'
import allProjectsAreUpToDate from './allProjectsAreUpToDate'
import extendOptions, {
  InstallOptions,
  StrictInstallOptions,
} from './extendInstallOptions'
import getPreferredVersionsFromPackage, { getPreferredVersionsFromLockfile } from './getPreferredVersions'
import getWantedDependencies, {
  PinnedVersion,
  WantedDependency,
} from './getWantedDependencies'
import linkPackages from './link'
import path = require('path')
import rimraf = require('@zkochan/rimraf')
import isInnerLink = require('is-inner-link')
import pFilter = require('p-filter')
import pLimit = require('p-limit')
import R = require('ramda')

export type DependenciesMutation = (
  {
    buildIndex: number
    mutation: 'install'
    pruneDirectDependencies?: boolean
  } | {
    allowNew?: boolean
    dependencySelectors: string[]
    mutation: 'installSome'
    peer?: boolean
    pruneDirectDependencies?: boolean
    pinnedVersion?: PinnedVersion
    targetDependenciesField?: DependenciesField
  } | {
    mutation: 'uninstallSome'
    dependencyNames: string[]
    targetDependenciesField?: DependenciesField
  } | {
    mutation: 'unlink'
  } | {
    mutation: 'unlinkSome'
    dependencyNames: string[]
  }
) & (
  {
    manifest: ProjectManifest
  }
)

export async function install (
  manifest: ProjectManifest,
  opts: InstallOptions & {
    preferredVersions?: PreferredVersions
  }
) {
  const projects = await mutateModules(
    [
      {
        buildIndex: 0,
        manifest,
        mutation: 'install',
        rootDir: opts.dir ?? process.cwd(),
      },
    ],
    opts
  )
  return projects[0].manifest
}

export type MutatedProject = ProjectOptions & DependenciesMutation

export async function mutateModules (
  projects: MutatedProject[],
  maybeOpts: InstallOptions & {
    preferredVersions?: PreferredVersions
  }
) {
  const reporter = maybeOpts?.reporter
  if (reporter && typeof reporter === 'function') {
    streamParser.on('data', reporter)
  }

  const opts = await extendOptions(maybeOpts)

  if (!opts.include.dependencies && opts.include.optionalDependencies) {
    throw new PnpmError('OPTIONAL_DEPS_REQUIRE_PROD_DEPS', 'Optional dependencies cannot be installed without production dependencies')
  }

  const installsOnly = projects.every((project) => project.mutation === 'install')
  opts['forceNewModules'] = installsOnly
  const ctx = await getContext(projects, opts)

  for (const { manifest, rootDir } of ctx.projects) {
    if (!manifest) {
      throw new Error(`No package.json found in "${rootDir}"`)
    }
  }

  const result = await _install()

  if (reporter && typeof reporter === 'function') {
    streamParser.removeListener('data', reporter)
  }

  return result

  async function _install (): Promise<Array<{ rootDir: string, manifest: ProjectManifest }>> {
    const frozenLockfile = opts.frozenLockfile ||
      opts.frozenLockfileIfExists && ctx.existsWantedLockfile
    if (
      !opts.lockfileOnly &&
      !opts.update &&
      installsOnly &&
      (
        frozenLockfile ||
        opts.preferFrozenLockfile &&
        (!opts.pruneLockfileImporters || Object.keys(ctx.wantedLockfile.importers).length === ctx.projects.length) &&
        ctx.existsWantedLockfile &&
        ctx.wantedLockfile.lockfileVersion === LOCKFILE_VERSION &&
        await allProjectsAreUpToDate(ctx.projects, {
          linkWorkspacePackages: opts.linkWorkspacePackagesDepth >= 0,
          wantedLockfile: ctx.wantedLockfile,
          workspacePackages: opts.workspacePackages,
        })
      )
    ) {
      if (!ctx.existsWantedLockfile) {
        if (ctx.projects.some((project) => pkgHasDependencies(project.manifest))) {
          throw new Error(`Headless installation requires a ${WANTED_LOCKFILE} file`)
        }
      } else {
        logger.info({ message: 'Lockfile is up-to-date, resolution step is skipped', prefix: opts.lockfileDir })
        try {
          await headless({
            currentEngine: {
              nodeVersion: opts.nodeVersion,
              pnpmVersion: opts.packageManager.name === 'pnpm' ? opts.packageManager.version : '',
            },
            currentLockfile: ctx.currentLockfile,
            engineStrict: opts.engineStrict,
            extraBinPaths: opts.extraBinPaths,
            force: opts.force,
            hoistedDependencies: ctx.hoistedDependencies,
            hoistPattern: ctx.hoistPattern,
            ignoreScripts: opts.ignoreScripts,
            include: opts.include,
            lockfileDir: ctx.lockfileDir,
            modulesDir: opts.modulesDir,
            ownLifecycleHooksStdio: opts.ownLifecycleHooksStdio,
            packageManager: opts.packageManager,
            pendingBuilds: ctx.pendingBuilds,
            projects: ctx.projects as Array<{
              binsDir: string
              buildIndex: number
              id: string
              manifest: ProjectManifest
              modulesDir: string
              rootDir: string
              pruneDirectDependencies?: boolean
            }>,
            pruneStore: opts.pruneStore,
            publicHoistPattern: ctx.publicHoistPattern,
            rawConfig: opts.rawConfig,
            registries: opts.registries,
            sideEffectsCacheRead: opts.sideEffectsCacheRead,
            sideEffectsCacheWrite: opts.sideEffectsCacheWrite,
            symlink: opts.symlink,
            skipped: ctx.skipped,
            storeController: opts.storeController,
            storeDir: opts.storeDir,
            unsafePerm: opts.unsafePerm,
            userAgent: opts.userAgent,
            virtualStoreDir: ctx.virtualStoreDir,
            wantedLockfile: ctx.wantedLockfile,
          })
          return projects
        } catch (error) {
          if (frozenLockfile || error.code !== 'ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY') throw error
          // A broken lockfile may be caused by a badly resolved Git conflict
          logger.warn({
            error,
            message: 'The lockfile is broken! Resolution step will be performed to fix it.',
            prefix: ctx.lockfileDir,
          })
        }
      }
    }

    const projectsToInstall = [] as ImporterToUpdate[]

    const projectsToBeInstalled = ctx.projects.filter(({ mutation }) => mutation === 'install') as Array<{ buildIndex: number, rootDir: string, manifest: ProjectManifest, modulesDir: string }>
    const scriptsOpts = {
      extraBinPaths: opts.extraBinPaths,
      rawConfig: opts.rawConfig,
      shellEmulator: opts.shellEmulator,
      stdio: opts.ownLifecycleHooksStdio,
      unsafePerm: opts.unsafePerm || false,
    }
    if (!opts.ignoreScripts) {
      await runLifecycleHooksConcurrently(
        ['preinstall'],
        projectsToBeInstalled,
        opts.childConcurrency,
        scriptsOpts
      )
    }

    // TODO: make it concurrent
    for (const project of ctx.projects) {
      switch (project.mutation) {
      case 'uninstallSome':
        projectsToInstall.push({
          pruneDirectDependencies: false,
          ...project,
          removePackages: project.dependencyNames,
          updatePackageManifest: true,
          wantedDependencies: [],
        })
        break
      case 'install': {
        await installCase({
          ...project,
          updatePackageManifest: opts.updatePackageManifest ?? opts.update,
        })
        break
      }
      case 'installSome': {
        await installSome({
          ...project,
          updatePackageManifest: opts.updatePackageManifest !== false,
        })
        break
      }
      case 'unlink': {
        const packageDirs = await readModulesDirs(project.modulesDir)
        const externalPackages = await pFilter(
          packageDirs!,
          (packageDir: string) => isExternalLink(ctx.storeDir, project.modulesDir, packageDir)
        )
        const allDeps = getAllDependenciesFromManifest(project.manifest)
        const packagesToInstall: string[] = []
        for (const pkgName of externalPackages) {
          await rimraf(path.join(project.modulesDir, pkgName))
          if (allDeps[pkgName]) {
            packagesToInstall.push(pkgName)
          }
        }
        if (!packagesToInstall.length) return projects

        // TODO: install only those that were unlinked
        // but don't update their version specs in package.json
        await installCase({ ...project, mutation: 'install' })
        break
      }
      case 'unlinkSome': {
        if (project.manifest?.name && opts.globalBin) {
          await removeBin(path.join(opts.globalBin, project.manifest?.name))
        }
        const packagesToInstall: string[] = []
        const allDeps = getAllDependenciesFromManifest(project.manifest)
        for (const depName of project.dependencyNames) {
          try {
            if (!await isExternalLink(ctx.storeDir, project.modulesDir, depName)) {
              logger.warn({
                message: `${depName} is not an external link`,
                prefix: project.rootDir,
              })
              continue
            }
          } catch (err) {
            if (err['code'] !== 'ENOENT') throw err // eslint-disable-line @typescript-eslint/dot-notation
          }
          await rimraf(path.join(project.modulesDir, depName))
          if (allDeps[depName]) {
            packagesToInstall.push(depName)
          }
        }
        if (!packagesToInstall.length) return projects

        // TODO: install only those that were unlinked
        // but don't update their version specs in package.json
        await installSome({
          ...project,
          dependencySelectors: packagesToInstall,
          mutation: 'installSome',
          updatePackageManifest: false,
        })
        break
      }
      }
    }

    async function installCase (project: any) { // eslint-disable-line
      const wantedDependencies = getWantedDependencies(project.manifest, {
        includeDirect: opts.includeDirect,
        updateWorkspaceDependencies: opts.update,
      })
        .map((wantedDependency) => ({ ...wantedDependency, updateSpec: true }))

      if (ctx.wantedLockfile?.importers) {
        forgetResolutionsOfPrevWantedDeps(ctx.wantedLockfile.importers[project.id], wantedDependencies)
      }
      const scripts = opts.ignoreScripts ? {} : (project.manifest?.scripts ?? {})
      if (opts.ignoreScripts && project.manifest?.scripts &&
        (project.manifest.scripts.preinstall || project.manifest.scripts.prepublish ||
          project.manifest.scripts.install ||
          project.manifest.scripts.postinstall ||
          project.manifest.scripts.prepare)
      ) {
        ctx.pendingBuilds.push(project.id)
      }

      if (scripts['prepublish']) { // eslint-disable-line @typescript-eslint/dot-notation
        logger.warn({
          message: '`prepublish` scripts are deprecated. Use `prepare` for build steps and `prepublishOnly` for upload-only.',
          prefix: project.rootDir,
        })
      }
      projectsToInstall.push({
        pruneDirectDependencies: false,
        ...project,
        wantedDependencies,
      })
    }

    async function installSome (project: any) { // eslint-disable-line
      const currentPrefs = opts.ignoreCurrentPrefs ? {} : getAllDependenciesFromManifest(project.manifest)
      const optionalDependencies = project.targetDependenciesField ? {} : project.manifest.optionalDependencies || {}
      const devDependencies = project.targetDependenciesField ? {} : project.manifest.devDependencies || {}
      const wantedDeps = parseWantedDependencies(project.dependencySelectors, {
        allowNew: project.allowNew !== false,
        currentPrefs,
        defaultTag: opts.tag,
        dev: project.targetDependenciesField === 'devDependencies',
        devDependencies,
        optional: project.targetDependenciesField === 'optionalDependencies',
        optionalDependencies,
        updateWorkspaceDependencies: opts.update,
      })
      projectsToInstall.push({
        pruneDirectDependencies: false,
        ...project,
        wantedDependencies: wantedDeps.map(wantedDep => ({ ...wantedDep, isNew: true, updateSpec: true })),
      })
    }

    // Unfortunately, the private lockfile may differ from the public one.
    // A user might run named installations on a project that has a pnpm-lock.yaml file before running a noop install
    const makePartialCurrentLockfile = !installsOnly && (
      ctx.existsWantedLockfile && !ctx.existsCurrentLockfile ||
      !ctx.currentLockfileIsUpToDate
    )
    const result = await installInContext(projectsToInstall, ctx, {
      ...opts,
      currentLockfileIsUpToDate: !ctx.existsWantedLockfile || ctx.currentLockfileIsUpToDate,
      makePartialCurrentLockfile,
      update: opts.update || !installsOnly,
      updateLockfileMinorVersion: true,
    })

    if (!opts.ignoreScripts) {
      await runLifecycleHooksConcurrently(['install', 'postinstall', 'prepublish', 'prepare'],
        projectsToBeInstalled,
        opts.childConcurrency,
        scriptsOpts
      )
    }

    return result
  }
}

async function isExternalLink (storeDir: string, modules: string, pkgName: string) {
  const link = await isInnerLink(modules, pkgName)

  return !link.isInner
}

function pkgHasDependencies (manifest: ProjectManifest) {
  return Boolean(
    R.keys(manifest.dependencies).length ||
    R.keys(manifest.devDependencies).length ||
    R.keys(manifest.optionalDependencies).length
  )
}

async function partitionLinkedPackages (
  dependencies: WantedDependency[],
  opts: {
    projectDir: string
    lockfileOnly: boolean
    modulesDir: string
    storeDir: string
    virtualStoreDir: string
    workspacePackages?: WorkspacePackages
  }
) {
  const nonLinkedDependencies: WantedDependency[] = []
  const linkedAliases = new Set<string>()
  for (const dependency of dependencies) {
    if (!dependency.alias || opts.workspacePackages?.[dependency.alias]) {
      nonLinkedDependencies.push(dependency)
      continue
    }
    const isInnerLink = await safeIsInnerLink(opts.modulesDir, dependency.alias, {
      hideAlienModules: !opts.lockfileOnly,
      projectDir: opts.projectDir,
      storeDir: opts.storeDir,
      virtualStoreDir: opts.virtualStoreDir,
    })
    if (isInnerLink === true) {
      nonLinkedDependencies.push(dependency)
      continue
    }
    // This info-log might be better to be moved to the reporter
    logger.info({
      message: `${dependency.alias} is linked to ${opts.modulesDir} from ${isInnerLink}`,
      prefix: opts.projectDir,
    })
    linkedAliases.add(dependency.alias)
  }
  return {
    linkedAliases,
    nonLinkedDependencies,
  }
}

// If the specifier is new, the old resolution probably does not satisfy it anymore.
// By removing these resolutions we ensure that they are resolved again using the new specs.
function forgetResolutionsOfPrevWantedDeps (importer: ProjectSnapshot, wantedDeps: WantedDependency[]) {
  if (!importer.specifiers) return
  importer.dependencies = importer.dependencies ?? {}
  importer.devDependencies = importer.devDependencies ?? {}
  importer.optionalDependencies = importer.optionalDependencies ?? {}
  for (const { alias, pref } of wantedDeps) {
    if (alias && importer.specifiers[alias] !== pref) {
      if (!importer.dependencies[alias]?.startsWith('link:')) {
        delete importer.dependencies[alias]
      }
      delete importer.devDependencies[alias]
      delete importer.optionalDependencies[alias]
    }
  }
}

export async function addDependenciesToPackage (
  manifest: ProjectManifest,
  dependencySelectors: string[],
  opts: InstallOptions & {
    allowNew?: boolean
    peer?: boolean
    pinnedVersion?: 'major' | 'minor' | 'patch'
    targetDependenciesField?: DependenciesField
  }
) {
  const projects = await mutateModules(
    [
      {
        allowNew: opts.allowNew,
        dependencySelectors,
        manifest,
        mutation: 'installSome',
        peer: opts.peer,
        pinnedVersion: opts.pinnedVersion,
        rootDir: opts.dir ?? process.cwd(),
        targetDependenciesField: opts.targetDependenciesField,
      },
    ],
    {
      ...opts,
      lockfileDir: opts.lockfileDir ?? opts.dir,
    })
  return projects[0].manifest
}

export type ImporterToUpdate = {
  binsDir: string
  id: string
  manifest: ProjectManifest
  originalManifest?: ProjectManifest
  modulesDir: string
  rootDir: string
  pruneDirectDependencies: boolean
  removePackages?: string[]
  updatePackageManifest: boolean
  wantedDependencies: Array<WantedDependency & { isNew?: Boolean, updateSpec?: Boolean }>
} & DependenciesMutation

async function installInContext (
  projects: ImporterToUpdate[],
  ctx: PnpmContext<DependenciesMutation>,
  opts: StrictInstallOptions & {
    makePartialCurrentLockfile: boolean
    updateLockfileMinorVersion: boolean
    preferredVersions?: PreferredVersions
    currentLockfileIsUpToDate: boolean
  }
) {
  if (opts.lockfileOnly && ctx.existsCurrentLockfile) {
    logger.warn({
      message: '`node_modules` is present. Lockfile only installation will make it out-of-date',
      prefix: ctx.lockfileDir,
    })
  }

  ctx.wantedLockfile.importers = ctx.wantedLockfile.importers || {}
  for (const { id } of projects) {
    if (!ctx.wantedLockfile.importers[id]) {
      ctx.wantedLockfile.importers[id] = { specifiers: {} }
    }
  }
  if (opts.pruneLockfileImporters) {
    const projectIds = new Set(projects.map(({ id }) => id))
    for (const wantedImporter of Object.keys(ctx.wantedLockfile.importers)) {
      if (!projectIds.has(wantedImporter)) {
        delete ctx.wantedLockfile.importers[wantedImporter]
      }
    }
  }

  await Promise.all(
    projects
      .map(async (project) => {
        if (project.mutation !== 'uninstallSome') return
        const _removeDeps = (manifest: ProjectManifest) => removeDeps(manifest, project.dependencyNames, { prefix: project.rootDir, saveType: project.targetDependenciesField })
        project.manifest = await _removeDeps(project.manifest)
        if (project.originalManifest) {
          project.originalManifest = await _removeDeps(project.originalManifest)
        }
      })
  )

  stageLogger.debug({
    prefix: ctx.lockfileDir,
    stage: 'resolution_started',
  })

  const preferredVersions = opts.preferredVersions ?? (
    (
      !opts.update &&
      ctx.wantedLockfile.packages &&
      !R.isEmpty(ctx.wantedLockfile.packages)
    ) ? getPreferredVersionsFromLockfile(ctx.wantedLockfile.packages) : undefined
  )
  const forceFullResolution = ctx.wantedLockfile.lockfileVersion !== LOCKFILE_VERSION ||
    !opts.currentLockfileIsUpToDate ||
    opts.force
  const _toResolveImporter = toResolveImporter.bind(null, {
    defaultUpdateDepth: (opts.update || opts.updateMatching) ? opts.depth : -1,
    lockfileOnly: opts.lockfileOnly,
    preferredVersions,
    storeDir: ctx.storeDir,
    updateAll: Boolean(opts.updateMatching),
    virtualStoreDir: ctx.virtualStoreDir,
    workspacePackages: opts.workspacePackages,
  })
  const projectsToResolve = await Promise.all(projects.map((project) => _toResolveImporter(project)))
  let {
    dependenciesGraph,
    dependenciesByProjectId,
    finishLockfileUpdates,
    linkedDependenciesByProjectId,
    newLockfile,
    outdatedDependencies,
    wantedToBeSkippedPackageIds,
    waitTillAllFetchingsFinish,
  } = await resolveDependencies(
    projectsToResolve,
    {
      currentLockfile: ctx.currentLockfile,
      dryRun: opts.lockfileOnly,
      engineStrict: opts.engineStrict,
      force: opts.force,
      forceFullResolution,
      hooks: opts.hooks,
      linkWorkspacePackagesDepth: opts.linkWorkspacePackagesDepth ?? (opts.saveWorkspaceProtocol ? 0 : -1),
      lockfileDir: opts.lockfileDir,
      nodeVersion: opts.nodeVersion,
      pnpmVersion: opts.packageManager.name === 'pnpm' ? opts.packageManager.version : '',
      preserveWorkspaceProtocol: opts.preserveWorkspaceProtocol,
      registries: opts.registries,
      saveWorkspaceProtocol: opts.saveWorkspaceProtocol,
      storeController: opts.storeController,
      strictPeerDependencies: opts.strictPeerDependencies,
      tag: opts.tag,
      updateMatching: opts.updateMatching,
      virtualStoreDir: ctx.virtualStoreDir,
      wantedLockfile: ctx.wantedLockfile,
      workspacePackages: opts.workspacePackages,
    }
  )

  stageLogger.debug({
    prefix: ctx.lockfileDir,
    stage: 'resolution_done',
  })

  newLockfile = opts.hooks?.afterAllResolved
    ? opts.hooks?.afterAllResolved(newLockfile)
    : newLockfile

  if (opts.updateLockfileMinorVersion) {
    newLockfile.lockfileVersion = LOCKFILE_VERSION
  }

  const lockfileOpts = { forceSharedFormat: opts.forceSharedLockfile }
  if (!opts.lockfileOnly) {
    const result = await linkPackages(
      projectsToResolve,
      dependenciesGraph,
      {
        currentLockfile: ctx.currentLockfile,
        dependenciesByProjectId,
        force: opts.force,
        hoistedDependencies: ctx.hoistedDependencies,
        hoistedModulesDir: ctx.hoistedModulesDir,
        hoistPattern: ctx.hoistPattern,
        include: opts.include,
        linkedDependenciesByProjectId,
        lockfileDir: opts.lockfileDir,
        makePartialCurrentLockfile: opts.makePartialCurrentLockfile,
        outdatedDependencies,
        pruneStore: opts.pruneStore,
        publicHoistPattern: ctx.publicHoistPattern,
        registries: ctx.registries,
        rootModulesDir: ctx.rootModulesDir,
        sideEffectsCacheRead: opts.sideEffectsCacheRead,
        symlink: opts.symlink,
        skipped: ctx.skipped,
        storeController: opts.storeController,
        strictPeerDependencies: opts.strictPeerDependencies,
        virtualStoreDir: ctx.virtualStoreDir,
        wantedLockfile: newLockfile,
        wantedToBeSkippedPackageIds,
      }
    )
    await finishLockfileUpdates()

    ctx.pendingBuilds = ctx.pendingBuilds
      .filter((relDepPath) => !result.removedDepPaths.has(relDepPath))

    if (opts.ignoreScripts) {
      // we can use concat here because we always only append new packages, which are guaranteed to not be there by definition
      ctx.pendingBuilds = ctx.pendingBuilds
        .concat(
          result.newDepPaths
            .filter((depPath) => dependenciesGraph[depPath].requiresBuild)
        )
    } else if (result.newDepPaths?.length) {
      // postinstall hooks
      const depPaths = Object.keys(dependenciesGraph)
      const rootNodes = depPaths.filter((depPath) => dependenciesGraph[depPath].depth === 0)

      await buildModules(dependenciesGraph, rootNodes, {
        childConcurrency: opts.childConcurrency,
        depsToBuild: new Set(result.newDepPaths),
        extraBinPaths: ctx.extraBinPaths,
        lockfileDir: ctx.lockfileDir,
        optional: opts.include.optionalDependencies,
        rawConfig: opts.rawConfig,
        rootModulesDir: ctx.virtualStoreDir,
        sideEffectsCacheWrite: opts.sideEffectsCacheWrite,
        storeController: opts.storeController,
        unsafePerm: opts.unsafePerm,
        userAgent: opts.userAgent,
      })
    }

    if (result.newDepPaths?.length) {
      const newPkgs = R.props<string, DependenciesGraphNode>(result.newDepPaths, dependenciesGraph)
      await linkAllBins(newPkgs, dependenciesGraph, {
        optional: opts.include.optionalDependencies,
        warn: (message: string) => logger.warn({ message, prefix: opts.lockfileDir }),
      })
    }

    await Promise.all(projectsToResolve.map(async (project, index) => {
      const linkedPackages = await linkBinsOfImporter(project)
      const projectToInstall = projects[index]
      if (opts.global && projectToInstall.mutation.includes('install')) {
        projectToInstall.wantedDependencies.forEach(pkg => {
          if (!linkedPackages?.includes(pkg.alias)) {
            logger.warn({ message: `${pkg.alias} has no binaries`, prefix: opts.lockfileDir })
          }
        })
      }
    }))

    await Promise.all([
      opts.useLockfile
        ? writeLockfiles({
          currentLockfile: result.currentLockfile,
          currentLockfileDir: ctx.virtualStoreDir,
          wantedLockfile: newLockfile,
          wantedLockfileDir: ctx.lockfileDir,
          ...lockfileOpts,
        })
        : writeCurrentLockfile(ctx.virtualStoreDir, result.currentLockfile, lockfileOpts),
      (() => {
        if (result.currentLockfile.packages === undefined && result.removedDepPaths.size === 0) {
          return Promise.resolve()
        }
        return writeModulesYaml(ctx.rootModulesDir, {
          ...ctx.modulesFile,
          hoistedDependencies: result.newHoistedDependencies,
          hoistPattern: ctx.hoistPattern,
          included: ctx.include,
          layoutVersion: LAYOUT_VERSION,
          packageManager: `${opts.packageManager.name}@${opts.packageManager.version}`,
          pendingBuilds: ctx.pendingBuilds,
          publicHoistPattern: ctx.publicHoistPattern,
          registries: ctx.registries,
          skipped: Array.from(ctx.skipped),
          storeDir: ctx.storeDir,
          virtualStoreDir: ctx.virtualStoreDir,
        })
      })(),
    ])
  } else {
    await finishLockfileUpdates()
    await writeWantedLockfile(ctx.lockfileDir, newLockfile, lockfileOpts)

    // This is only needed because otherwise the reporter will hang
    stageLogger.debug({
      prefix: opts.lockfileDir,
      stage: 'importing_done',
    })
  }

  await waitTillAllFetchingsFinish()

  summaryLogger.debug({ prefix: opts.lockfileDir })

  await opts.storeController.close()

  return projectsToResolve.map(({ manifest, rootDir }) => ({ rootDir, manifest }))
}

async function toResolveImporter (
  opts: {
    defaultUpdateDepth: number
    lockfileOnly: boolean
    preferredVersions?: PreferredVersions
    storeDir: string
    updateAll: boolean
    virtualStoreDir: string
    workspacePackages: WorkspacePackages
  },
  project: ImporterToUpdate
) {
  const allDeps = getWantedDependencies(project.manifest)
  const { linkedAliases, nonLinkedDependencies } = await partitionLinkedPackages(allDeps, {
    lockfileOnly: opts.lockfileOnly,
    modulesDir: project.modulesDir,
    projectDir: project.rootDir,
    storeDir: opts.storeDir,
    virtualStoreDir: opts.virtualStoreDir,
    workspacePackages: opts.workspacePackages,
  })
  const existingDeps = nonLinkedDependencies
    .filter(({ alias }) => !project.wantedDependencies.some((wantedDep) => wantedDep.alias === alias))
  let wantedDependencies!: Array<WantedDependency & { isNew?: boolean, updateDepth: number }>
  if (!project.manifest) {
    wantedDependencies = [
      ...project.wantedDependencies,
      ...existingDeps,
    ]
      .map((dep) => ({
        ...dep,
        updateDepth: opts.defaultUpdateDepth,
      }))
  } else {
    // Direct local tarballs are always checked,
    // so their update depth should be at least 0
    const updateLocalTarballs = (dep: WantedDependency) => ({
      ...dep,
      updateDepth: opts.updateAll
        ? opts.defaultUpdateDepth : (prefIsLocalTarball(dep.pref) ? 0 : -1),
    })
    wantedDependencies = [
      ...project.wantedDependencies.map(
        opts.defaultUpdateDepth < 0
          ? updateLocalTarballs
          : (dep) => ({ ...dep, updateDepth: opts.defaultUpdateDepth })),
      ...existingDeps.map(updateLocalTarballs),
    ]
  }
  return {
    ...project,
    hasRemovedDependencies: Boolean(project.removePackages?.length),
    preferredVersions: opts.preferredVersions ?? (project.manifest && getPreferredVersionsFromPackage(project.manifest)) ?? {},
    wantedDependencies: wantedDependencies
      .filter(({ alias, updateDepth }) => updateDepth >= 0 || !linkedAliases.has(alias)),
  }
}

function prefIsLocalTarball (pref: string) {
  return pref.startsWith('file:') && pref.endsWith('.tgz')
}

const limitLinking = pLimit(16)

function linkBinsOfImporter ({ modulesDir, binsDir, rootDir }: ImporterToResolve) {
  const warn = (message: string) => logger.info({ message, prefix: rootDir })
  return linkBins(modulesDir, binsDir, { allowExoticManifests: true, warn })
}

function linkAllBins (
  depNodes: DependenciesGraphNode[],
  depGraph: DependenciesGraph,
  opts: {
    optional: boolean
    warn: (message: string) => void
  }
) {
  return Promise.all(
    depNodes.map(depNode => limitLinking(() => linkBinsOfDependencies(depNode, depGraph, opts)))
  )
}
