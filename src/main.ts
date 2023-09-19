import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as downloader from './downloader'
import * as input from './inputs'
import * as installer from './installer'
import * as path from 'path'
import * as platform from './platform'
import * as version_getter from './versiongetter'

async function get_vulkan_sdk(
  version: string,
  destination: string,
  optional_components: string[],
  use_cache: boolean
): Promise<string> {
  let install_path: string
  let ver = await version_getter.resolve_version(version)

  const cachePrimaryKey = `cache-vulkan-sdk-${version}-${platform.OS_PLATFORM}-${platform.OS_ARCH}`

  // restore from cache
  if (use_cache) {
    let restoredFromCacheId = undefined

    // .slice() to workaround https://github.com/actions/toolkit/issues/1377
    restoredFromCacheId = await cache.restoreCache([destination].slice(), cachePrimaryKey)

    if (restoredFromCacheId === undefined) {
      core.info(`🎯 [Cache] Cache for 'Vulkan SDK' not found.`)
    } else {
      core.info(
        `🎯 [Cache] Restored Vulkan SDK '${ver}' in path: '${destination}'. Cache Restore ID: '${restoredFromCacheId}'.`
      )

      return destination // Exit early with the cached destination, e.g. C:\VulkanSDK
    }
  }

  // download + install
  // if use_cache = false (cache is not used)
  // if use_cache = true && cacheKey = false (cache is used, but not found)
  const vulkan_sdk_path = await downloader.download_vulkan_sdk(ver)
  install_path = await installer.install_vulkan_sdk(vulkan_sdk_path, destination, ver, optional_components)

  // cache install folder
  if (use_cache) {
    try {
      const cacheId = await cache.saveCache([install_path], cachePrimaryKey)
      core.info(`🎯 [Cache] Saved Vulkan SDK '${ver}' in path: '${install_path}'. Cache Save ID: '${cacheId}'.`)
    } catch (error: any) {
      core.warning(error)
    }
  }

  // source the setup-env.sh file in the vulkan sdk installation folder
  await exec('bash', ['./setup-env.sh'], {cwd: install_path})

  return install_path
}

async function get_vulkan_runtime(version: string, destination: string, use_cache: boolean): Promise<string> {
  let install_path: string
  let ver = await version_getter.resolve_version(version)

  const cacheKey = `cache-vulkan-rt-${version}-${platform.OS_PLATFORM}-${platform.OS_ARCH}`

  // restore from cache
  if (use_cache) {
    let restoredFromCacheId = undefined
    restoredFromCacheId = await cache.restoreCache([destination], cacheKey)

    if (restoredFromCacheId === undefined) {
      core.info(`🎯 [Cache] Cache for 'Vulkan Runtime' not found.`)
    } else {
      core.info(
        `🎯 [Cache] Restored Vulkan Runtime '${ver}' in path: '${destination}'. Cache Restore ID: '${restoredFromCacheId}'.`
      )

      return destination // Exit early with the cached destination
    }
  }

  // download + install
  const vulkan_runtime_path = await downloader.download_vulkan_runtime(ver)
  install_path = await installer.install_vulkan_runtime(vulkan_runtime_path, destination)

  // cache install folder
  if (use_cache) {
    try {
      const cacheId = await cache.saveCache([install_path], cacheKey)
      core.info(`🎯 [Cache] Saved Vulkan Runtime '${ver}' in path: '${install_path}'. Cache Save ID: '${cacheId}'.`)
    } catch (error: any) {
      core.warning(error)
    }
  }

  return install_path
}

/**
 * Prints errors to the GitHub Actions console.
 * Lets action exit with exit code 1.
 */
function errorHandler(error: Error): void {
  let message = error.stack || error.message || String(error)
  core.setFailed(message)
  //process.exit()
}

async function run(): Promise<void> {
  try {
    const inputs: input.Inputs = await input.getInputs()

    const version = await version_getter.resolve_version(inputs.version)

    const sdk_path = await get_vulkan_sdk(version, inputs.destination, inputs.optional_components, inputs.use_cache)

    const sdk_versionized_path = path.normalize(`${sdk_path}/${version}`)

    core.addPath(`${sdk_versionized_path}`)
    core.info(`✔️ [PATH] Added path to Vulkan SDK to environment variable PATH.`)

    core.exportVariable('VULKAN_SDK', `${sdk_versionized_path}`)
    core.info(`✔️ [ENV] Set env variable VULKAN_SDK -> "${sdk_versionized_path}".`)

    core.exportVariable('VULKAN_VERSION', `${version}`)
    core.info(`✔️ [ENV] Set env variable VULKAN_VERSION -> "${version}".`)

    if (inputs.install_runtime /*&& platform.IS_WINDOWS*/) {
      const install_path = await get_vulkan_runtime(version, inputs.destination, inputs.use_cache)

      core.info(`✔️ [INFO] Path to Vulkan Runtime: ${install_path}`)
    }
  } catch (error: any) {
    errorHandler(error as Error)
  }
}

run()
