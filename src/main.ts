import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as path from 'path'
import * as downloader from './downloader'
import * as input from './inputs'
import * as installer from './installer'
import * as platform from './platform'
import * as version_getter from './versiongetter'

/**
 * Get Cache Keys
 *
 * Format will be "cache-OS-ARCH-vulkan-sdk-VERSION-HASH".
 * E.g. "cache-linux-x64-vulkan-sdk-1.3.250.1-hash".
 *
 * @param {string} version - The Vulkan SDK version.
 * @param {string} path - The Vulkan SDK installation path.
 * @return {*}  {Promise<{ cachePrimaryKey: string; cacheRestoreKeys: string[]; }>}
 */
async function getCacheKeys(
  version: string,
  path: string
): Promise<{cachePrimaryKey: string; cacheRestoreKeys: string[]}> {
  // Note: getPlatform() is used to get "windows", instead of OS_PLATFORM value "win32"
  const cachePrimaryKey = `cache-${platform.getPlatform()}-${platform.OS_ARCH}-vulkan-sdk-${version}`
  const cacheRestoreKey1 = `cache-${platform.getPlatform()}-${platform.OS_ARCH}-vulkan-sdk-`
  const cacheRestoreKey2 = `cache-${platform.getPlatform()}-${platform.OS_ARCH}-`
  return {cachePrimaryKey, cacheRestoreKeys: [cacheRestoreKey1, cacheRestoreKey2]}
}

/**
 * Retrieves and installs the Vulkan SDK.
 *
 * @param {string} version - The version of the Vulkan SDK to install.
 * @param {string} destination - The directory where the Vulkan SDK will be installed.
 * @param {string[]} optional_components - An array of optional components to install alongside the SDK.
 * @param {boolean} use_cache - Whether to use a cached SDK, if available. And store SDK to cache, if not available.
 * @param {boolean} stripdown - Whether to reduce the size of the installed SDK for caching.
 * @param {boolean} install_runtime - Whether to install the Vulkan runtime.
 * @return {*}  {Promise<string>} A Promise that resolves to the path where the Vulkan SDK is installed.
 */
async function get_vulkan_sdk(
  version: string,
  destination: string,
  optional_components: string[],
  use_cache: boolean,
  stripdown: boolean,
  install_runtime: boolean
): Promise<string> {
  let install_path: string

  const {cachePrimaryKey, cacheRestoreKeys} = await getCacheKeys(version, destination)

  // restore from cache
  if (use_cache) {
    let cacheHit = undefined
    if (platform.IS_WINDOWS) {
      const versionized_destination_path = path.normalize(`${destination}/${version}`)
      cacheHit = await cache.restoreCache([versionized_destination_path], cachePrimaryKey, cacheRestoreKeys)
    } else {
      cacheHit = await cache.restoreCache([destination], cachePrimaryKey, cacheRestoreKeys)
    }
    if (cacheHit === undefined) {
      core.info(`🎯 [Cache] Cache for 'Vulkan SDK' not found.`)
    } else {
      core.info(`🎯 [Cache] Restored Vulkan SDK in path: '${destination}'. Cache Restore ID: '${cacheHit}'.`)
      return destination // Exit early with the cached destination, e.g. C:\VulkanSDK
    }
  }

  /*
    Download and install RT and SDK with the following conditions:
     - if (use_cache = false)                    means cache is not used
     - if (use_cache = true && cacheHit = false) means cache is used, but not found
  */

  // Download and install SDK
  const vulkan_sdk_path = await downloader.download_vulkan_sdk(version)
  install_path = await installer.install_vulkan_sdk(vulkan_sdk_path, destination, version, optional_components)

  // Download and install Runtime after the SDK. This allows caching both.
  if (platform.IS_WINDOWS && install_runtime) {
    const vulkan_runtime_path = await downloader.download_vulkan_runtime(version)
    await installer.install_vulkan_runtime(vulkan_runtime_path, destination, version)
  }

  // cache install folder
  if (use_cache) {
    if (stripdown) {
      installer.stripdown_installation_of_sdk(install_path)
    }
    try {
      const cacheId = await cache.saveCache([install_path], cachePrimaryKey)
      if (cacheId != -1) {
        core.info(`🎯 [Cache] Saved Vulkan SDK in path: '${install_path}'. Cache Save ID: '${cacheId}'.`)
      }
    } catch (error: any) {
      core.warning(error)
    }
  }
  return install_path
}

/**
 * Error handler, prints errors to the GitHub Actions console
 * and let's the action exit with exit code 1.
 *
 * @param {Error} error
 */
function errorHandler(error: Error): void {
  let message = error.stack || error.message || String(error)
  core.setFailed(message)
}

/**
 * This is the main function.
 *
 * @return {*}  {Promise<void>}
 */
async function run(): Promise<void> {
  try {
    const inputs: input.Inputs = await input.getInputs()

    const version = await version_getter.resolve_version(inputs.version)

    const sdk_path = await get_vulkan_sdk(
      version,
      inputs.destination,
      inputs.optional_components,
      inputs.use_cache,
      inputs.stripdown,
      inputs.install_runtime
    )

    // let install_path be a versionized path to the SDK
    let install_path = sdk_path
    if (!sdk_path.includes(version)) {
      install_path = path.normalize(`${sdk_path}/${version}`)
    }

    if (installer.verify_installation_of_sdk(install_path)) {
      // Setup Paths to the Vulkan SDK
      //
      // https://vulkan.lunarg.com/doc/sdk/1.3.261.1/linux/getting_started.html#set-up-the-runtime-environment
      //
      // According to the docs one would "source ~/vulkan/1.x.yy.z/setup-env.sh".
      // But here we setup our paths by setting these environment variables ourself.
      // We set PATH, VULKAN_SDK, VK_LAYER_PATH, LD_LIBRARY_PATH and additionally VULKAN_VERSION.

      // export PATH=$VULKAN_SDK/bin:$PATH
      if(platform.IS_WINDOWS) {
        core.addPath(`${install_path}\\Bin`)
      } else {
        core.addPath(`${install_path}/bin`)
      }
      core.info(`✔️ [PATH] Added path to Vulkan SDK to environment variable PATH.`)

      // export VULKAN_SDK=~/vulkan/1.x.yy.z/x86_64
      core.exportVariable('VULKAN_SDK', install_path)
      core.info(`✔️ [ENV] Set env variable VULKAN_SDK -> "${install_path}".`)

      core.exportVariable('VULKAN_VERSION', version)
      core.info(`✔️ [ENV] Set env variable VULKAN_VERSION -> "${version}".`)

      if (platform.IS_LINUX) {
        // export VK_LAYER_PATH=$VULKAN_SDK/etc/vulkan/explicit_layer.d
        const vk_layer_path = `${install_path}/etc/vulkan/explicit_layer.d`
        core.exportVariable('VK_LAYER_PATH', vk_layer_path)
        core.info(`✔️ [ENV] Set env variable VK_LAYER_PATH -> "${vk_layer_path}".`)

        // export LD_LIBRARY_PATH=$VULKAN_SDK/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
        const ld_library_path = process.env.LD_LIBRARY_PATH || ''
        const vk_ld_library_path = `${install_path}/lib:${ld_library_path}`
        core.exportVariable('LD_LIBRARY_PATH', vk_ld_library_path)
        core.info(`✔️ [ENV] Set env variable LD_LIBRARY_PATH -> "${vk_ld_library_path}".`)
      }
    } else {
      core.warning(`Could not find Vulkan SDK in ${install_path}`)
    }

    if (platform.IS_WINDOWS && inputs.install_runtime) {
      let runtime_path = `${install_path}\\runtime`
      if (installer.verify_installation_of_runtime(install_path)) {
        core.info(`✔️ [INFO] Path to Vulkan Runtime: ${runtime_path}`)
      } else {
        core.warning(`Could not find Vulkan Runtime in ${runtime_path}`)
      }
    }

    core.info(`✅ Done.`)
  } catch (error: any) {
    errorHandler(error as Error)
  }
}

run()
