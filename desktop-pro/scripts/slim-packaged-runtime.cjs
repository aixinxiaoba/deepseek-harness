
/**
 * afterPack钩子：安全瘦身打包输出 + 门禁验证
 *
 * 瘦身策略：
 * 1. 删除非 win32 预编译二进制（node_modules/**/prebuilds/* 只保留 win32-x64）
 * 2. 删除所有 sourcemap（*.js.map 和 *.d.ts.map）
 * 3. 删除非必需语言包（只保留 zh-CN.pak、en-US.pak、en-GB.pak）
 *
 * 瘦身后调用 verify-packaged-runtime.cjs 门禁验证闭包完整性
 */
const fs = require('node:fs')
const path = require('node:path')

module.exports = function slimPackagedRuntime(context) {
  const { appOutDir, electronPlatformName: platform } = context
  const resources = path.join(appOutDir, 'resources')
  const unpacked = path.join(resources, 'app.asar.unpacked')
  const modules = path.join(unpacked, 'node_modules')

  if (platform !== 'win32') {
    console.log(`[slim] 跳过非 win32 平台 (${platform})`)
    const verifyHook = require('./verify-packaged-runtime.cjs')
    verifyHook(context)
    return
  }

  console.log(`[slim] 开始瘦身 win32 打包输出`)

  // 1. 剪除非 win32 预编译二进制
  const prebuildResult = slimPrebuilds(modules)

  // 2. 剪除 sourcemap
  const sourcemapResult = slimSourcemaps(modules)

  // 3. 剪除非必需语言包
  const localesResult = slimLocales(appOutDir)

  console.log(`[slim] 瘦身完成:`)
  console.log(`  - 预编译二进制: 删除 ${prebuildResult.count} 个，释放 ${formatBytes(prebuildResult.bytes)}`)
  console.log(`  - Sourcemap: 删除 ${sourcemapResult.count} 个，释放 ${formatBytes(sourcemapResult.bytes)}`)
  console.log(`  - 语言包: 删除 ${localesResult.count} 个，释放 ${formatBytes(localesResult.bytes)}`)
  console.log(`  - 总计释放: ${formatBytes(prebuildResult.bytes + sourcemapResult.bytes + localesResult.bytes)}`)

  // 4. 门禁验证（确保瘦身没有破坏闭包完整性）
  const verifyHook = require('./verify-packaged-runtime.cjs')
  verifyHook(context)
}

/**
 * 扫描并删除 node_modules 下所有 prebuilds 目录中的非 win32 平台预编译二进制
 * 保留 win32-x64，删除 darwin-arm64、darwin-x64、linux-arm64、linux-x64 等
 */
function slimPrebuilds(modulesPath) {
  let count = 0
  let bytes = 0

  try {
    // 扫描所有 prebuilds 目录
    const prebuildsDirs = findDirectories(modulesPath, 'prebuilds')

    for (const prebuildsDir of prebuildsDirs) {
      const platforms = fs.readdirSync(prebuildsDir)

      for (const platform of platforms) {
        if (platform === 'win32-x64') continue // 保留

        const platformPath = path.join(prebuildsDir, platform)
        const stat = fs.statSync(platformPath)

        if (stat.isDirectory()) {
          const dirSize = getDirectorySize(platformPath)
          fs.rmSync(platformPath, { recursive: true, force: true })
          count++
          bytes += dirSize
        }
      }
    }
  } catch (error) {
    console.warn(`[slim] 预编译二进制清理警告: ${error.message}`)
  }

  return { count, bytes }
}

/**
 * 递归删除 node_modules 下所有 *.js.map 和 *.d.ts.map 文件
 */
function slimSourcemaps(modulesPath) {
  let count = 0
  let bytes = 0

  try {
    // 查找所有 .js.map 和 .d.ts.map 文件
    const jsMaps = findFiles(modulesPath, '.js.map', true)
    const dtsMaps = findFiles(modulesPath, '.d.ts.map', true)

    for (const file of [...jsMaps, ...dtsMaps]) {
      try {
        const stat = fs.statSync(file)
        fs.unlinkSync(file)
        count++
        bytes += stat.size
      } catch (error) {
        console.warn(`[slim] 无法删除 sourcemap ${file}: ${error.message}`)
      }
    }
  } catch (error) {
    console.warn(`[slim] Sourcemap 清理警告: ${error.message}`)
  }

  return { count, bytes }
}

/**
 * 删除 resources/locales/ 目录下非必需的语言包
 * 只保留 zh-CN.pak、en-US.pak、en-GB.pak
 */
function slimLocales(appOutDir) {
  let count = 0
  let bytes = 0

  try {
    const localesDir = path.join(appOutDir, 'resources', 'locales')
    if (!fs.existsSync(localesDir)) {
      return { count, bytes }
    }

    const keepFiles = new Set(['zh-CN.pak', 'en-US.pak', 'en-GB.pak'])
    const files = fs.readdirSync(localesDir)

    for (const file of files) {
      if (!keepFiles.has(file) && file.endsWith('.pak')) {
        const filePath = path.join(localesDir, file)
        try {
          const stat = fs.statSync(filePath)
          fs.unlinkSync(filePath)
          count++
          bytes += stat.size
        } catch (error) {
          console.warn(`[slim] 无法删除语言包 ${file}: ${error.message}`)
        }
      }
    }
  } catch (error) {
    console.warn(`[slim] 语言包清理警告: ${error.message}`)
  }

  return { count, bytes }
}

/**
 * 递归查找指定名称的目录
 */
function findDirectories(rootPath, dirName) {
  const results = []

  function search(currentPath) {
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name)

        if (entry.isDirectory()) {
          if (entry.name === dirName) {
            results.push(fullPath)
          } else {
            // 跳过 node_modules 内部的 node_modules 以避免无限循环
            if (entry.name !== 'node_modules' && entry.name !== '.cache') {
              search(fullPath)
            }
          }
        }
      }
    } catch (error) {
      // 忽略无权限访问的目录
    }
  }

  search(rootPath)
  return results
}

/**
 * 递归查找指定扩展名的文件
 */
function findFiles(rootPath, extension, recursive = false) {
  const results = []

  function search(currentPath) {
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name)

        if (entry.isDirectory()) {
          if (recursive && entry.name !== 'node_modules' && entry.name !== '.cache') {
            search(fullPath)
          }
        } else if (entry.name.endsWith(extension)) {
          results.push(fullPath)
        }
      }
    } catch (error) {
      // 忽略无权限访问的目录
    }
  }

  search(rootPath)
  return results
}

/**
 * 计算目录大小（字节）
 */
function getDirectorySize(dirPath) {
  let size = 0

  function calculate(currentPath) {
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name)

        try {
          const stat = fs.statSync(fullPath)
          if (stat.isDirectory()) {
            calculate(fullPath)
          } else {
            size += stat.size
          }
        } catch (error) {
          // 跳过无法访问的文件
        }
      }
    } catch (error) {
      // 跳过无法访问的目录
    }
  }

  calculate(dirPath)
  return size
}

/**
 * 格式化字节为可读大小
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}
