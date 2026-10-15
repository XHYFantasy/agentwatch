# 构建APK.ps1 — 一键构建「AI 监看」APK（T9 的 App 壳）
#
# 抄的是「实时术语解释助手」那份（同一个构建链、同一个 D 盘约定）。
# 本工程只有一个模块 `app`，所以没有 -Module 那个坑。
#
# 环境全部在 D 盘（「不占 C 盘」是本机的约定）。下面是**默认值，只为「本机直接双击就跑」**——
# 每一项都能用同名环境变量覆盖，别人 clone 下来不必改这个文件：
#
#   AGENTWATCH_JDK        D:\Android\jdk
#   AGENTWATCH_SDK        D:\Android\sdk
#   AGENTWATCH_GRADLE     D:\Android\gradle-dist\gradle-9.8.0
#   AGENTWATCH_CACHE      D:\Android\gradle
#   AGENTWATCH_KEYSTORE   D:\Android\keystore\keystore.properties
#
# ⚠️ 签名**故意放在工程目录之外**（T9-f）：这个工程要开源，而 `.gitignore` 防不住手滑 ——
#    密钥一旦进了公开历史就改不掉，只能换密钥重新发版。放外面，那条路根本不存在。
#    另见 app/build.gradle 顶部。
#
# 用法：
#   .\构建APK.ps1                     编译 debug APK
#   .\构建APK.ps1 -Release            编译 release APK（自建 keystore 签名）
#   .\构建APK.ps1 -Install            编译并安装到已连接设备
#   .\构建APK.ps1 -Release -Install   编译 release 并安装
#   .\构建APK.ps1 -Install -Logcat    编译、安装、跟日志（TAG=AgentWatch）
#
# ⚠️ debug 与 release 签名不同 ⇒ 两者互装会报 INSTALL_FAILED_UPDATE_INCOMPATIBLE。
#    换签名时必须**先卸载**（卸载会清掉配置；默认地址是构建时烧进包里的，重装即恢复）。
#    详见 安装说明.md。

param(
    [switch]$Release,
    [switch]$Install,
    [switch]$Logcat,
    [switch]$ClearLog
)

$LogTag = 'AgentWatch'

# 「有环境变量就用，没有就用默认值」—— PS 5.1 没有 ?? 运算符，只能写成函数
function Get-EnvOr([string]$Name, [string]$Default) {
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($v)) { $Default } else { $v }
}

$JdkDir     = Get-EnvOr 'AGENTWATCH_JDK'      "D:\Android\jdk"
$SdkDir     = Get-EnvOr 'AGENTWATCH_SDK'      "D:\Android\sdk"
$GradleDir  = Get-EnvOr 'AGENTWATCH_GRADLE'   "D:\Android\gradle-dist\gradle-9.8.0"
$KeyStore   = Get-EnvOr 'AGENTWATCH_KEYSTORE' "D:\Android\keystore\keystore.properties"
$ProjectDir = Join-Path $PSScriptRoot "android"
$LogFile    = Join-Path $PSScriptRoot "logs\build.log"

$env:JAVA_HOME         = $JdkDir
$env:ANDROID_HOME      = $SdkDir
$env:GRADLE_USER_HOME  = Get-EnvOr 'AGENTWATCH_CACHE'    "D:\Android\gradle"
$env:ANDROID_USER_HOME = Get-EnvOr 'AGENTWATCH_USERHOME' "D:\Android\userhome"
# build.gradle 靠这个变量找签名配置 —— 口令不进工程目录，见 app/build.gradle 顶部那段
$env:AGENTWATCH_KEYSTORE = $KeyStore

if (-not (Test-Path $ProjectDir)) { Write-Output "找不到工程目录：$ProjectDir"; exit 1 }
New-Item -ItemType Directory -Force (Split-Path $LogFile) | Out-Null

# PS 5.1 没有三元运算符，这里只能这么写
$variant = 'debug'
$task    = ':app:assembleDebug'
if ($Release) { $variant = 'release'; $task = ':app:assembleRelease' }

if ($Release -and -not (Test-Path $KeyStore)) {
    Write-Output "⚠️ 找不到签名配置 $KeyStore —— 这一版会退回 debug 签名，确认这是你要的。"
}

Write-Output "构建中（$variant）... 完整日志：$LogFile"

# 必须用 -p 指定工程目录：
#   Set-Location 不会改变 cmd / 原生进程的工作目录（PowerShell 的「当前位置」是
#   provider 概念，与 [Environment]::CurrentDirectory 不同步）。
cmd /c "`"$GradleDir\bin\gradle.bat`" -p `"$ProjectDir`" $task --no-daemon > `"$LogFile`" 2>&1"
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Output "构建失败（退出码 $code），最后 30 行："
    Get-Content $LogFile -Tail 30 -Encoding UTF8
    exit $code
}

$apk = Join-Path $ProjectDir "app\build\outputs\apk\$variant\app-$variant.apk"
if (-not (Test-Path $apk)) { Write-Output "构建成功但未找到 APK：$apk"; exit 1 }
Write-Output ("构建成功：{0}`n大小：{1:N1} MB  （{2}）" -f $apk, ((Get-Item $apk).Length/1MB), (Get-Item $apk).LastWriteTime)

# release 包顺手验签名 —— 「装上了」不等于「是 release 签的」
if ($Release) {
    $bt = (Get-ChildItem "$SdkDir\build-tools" -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
    Write-Output "签名（apksigner）："
    & "$bt\apksigner.bat" verify --print-certs $apk | Select-String 'DN:|SHA-256 digest'
}

if ($Install -or $Logcat) {
    Write-Output "安装到设备..."
    adb install -r $apk
    if ($LASTEXITCODE -ne 0) { Write-Output "安装失败（退出码 $LASTEXITCODE）"; exit $LASTEXITCODE }
}
if ($Logcat) {
    if ($ClearLog) { adb logcat -c }
    Write-Output "开始 logcat（TAG=$LogTag），Ctrl+C 退出"
    adb logcat -s $LogTag
}
