package com.agentwatch.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/**
 * T9-a —— 最小裸壳：**一个全屏 WebView，别的什么都没有**。
 *
 * 🔴 本步唯一的目的是回答 **D18**：dsh 那个 13MB 的 SPA，能不能在系统 WebView 里跑起来？
 *    这是整个 T9 方案的最大风险 —— 通知、指纹、缓存全押在它身上。它不成立，
 *    T9-c/d/e 一行都不用写。
 *
 * 所以这里**故意不加**任何原生能力（通知 / 指纹 / 设置页都留给 T9-b 之后）：
 * 变量越少，结论越干净。T9-a 挂了要能一眼看出是 WebView 的问题，不是别的东西。
 *
 * 地址走 `AppConfig`（默认值是**构建时注入**的，源头在 `android/local.properties`，
 * 见 `app/build.gradle` 顶部。链路：手机 → `<你的地址>:3080` →（纯 TCP 透传）→ PC 127.0.0.1:3081）。
 * ⚠️ 这里**不再写死任何地址** —— 理由见 build.gradle 顶部那段：写死了别人 clone 下来就
 *    永远连不上，而那个故障的症状恰好是「手机上安安静静什么都没发生」，最难查的一类。
 *
 * T9-d 起本 Activity 还多三件事：拉起 `WatchService`（常驻监听 + 待批通知）、
 * 申请通知权限、把「App 在不在前台」告诉 Service（前台不弹通知 —— 屏幕上已经有
 * dsh 原生那张审批卡了）。
 *
 * T9-d8：从**审批通知**点进来时，还要**真的切到那条审批所属的会话**。
 *   ——之前点开只是「打开 App」，停在**上次浏览的那个会话**（T9-d 验收 ③ 就是这么败的：
 *     提醒没错、卡也在、切过去就能批，但点开开错了门）。
 *   实现分三段，缺一不可：插件宿主半送 `sessionId`（①）→ 插件客户端半露出
 *   `window.__agentwatchOpenSession(id)`（②）→ 这里等页面和钩子就绪后调它（③）。
 */
class MainActivity : Activity() {

    private lateinit var web: WebView

    // ---- T9-d8：点审批通知 → 切到那条审批所属的会话 ----
    /** 用户想去哪个会话。为 null = 没有待办的跳转。 */
    private var wantSessionId: String? = null
    /** 已经试了几次。⚠️ 只在**页面加载完之后**才计数，见 `pageReady`。 */
    private var navTries = 0
    /**
     * 页面加载完过没有。
     *
     * 🔴 这不是优化，是**必要条件**：冷启动时通知点进来，WebView 才刚开始 loadUrl，
     *    此时钩子必然不存在。要是从那一刻就开始数重试次数，20 次 × 700ms ≈ 14 秒
     *    会在页面还没跑起来时就烧光，然后**恰好在页面刚就绪的那一刻放弃** ——
     *    症状是「有时能直达、有时不能」，比一直不能还难查。
     */
    private var pageReady = false
    private val ui = Handler(Looper.getMainLooper())

    /**
     * B2 —— 正在等用户选文件时，WebView 交给我们的那个回执口。
     *
     * 🔴 **它必须被回值，恰好一次。** WebView 侧的状态机就卡在这上面：只要有一个
     *    callback 悬着没回，页面里那个 file input 就**永远是「还在选」**，
     *    之后再点「添加文件」**再也不会有任何反应**（比一开始就不能选更难查，
     *    因为看起来像「偶尔失灵」）。所以：用户取消要回 `null`，异常路径也要回 `null`。
     */
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // ---- 诊断开关：允许 DevTools 挂上来 ----
        // T9-a 就是来查「跑没跑起来 / 卡在哪一步」的。没有这个就只能靠肉眼看界面，
        // 而 SPA 起不来时界面通常只是一片白 ⇒ 白屏和「其实起来了但样式崩了」分不开。
        // 开了之后：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
        //            → curl http://127.0.0.1:9222/json 就能拿到页面列表和 JS 求值口子。
        WebView.setWebContentsDebuggingEnabled(true)

        web = WebView(this)
        setContentView(
            web,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        applySystemBarInsets(web)

        web.settings.apply {
            javaScriptEnabled = true     // dsh 的 SPA 全靠 JS
            domStorageEnabled = true     // SPA 往 localStorage / sessionStorage 里写状态
            // 刻意不设 useWideViewPort / loadWithOverviewMode：
            // 手机浏览器现在就能正常打开这个地址，说明 dsh 的 SPA 是响应式的。
            // WebView 保持默认视口即可 —— 硬掰成桌面宽度只会引入一个我们自己造的变量。
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        // Cookie：dsh 的鉴权就靠一张 30 天的 `dsh-auth-*` cookie。
        //
        // ⚠️ 这里有个坑要盯住：bridge 对「没 cookie 且 URL 里没 token」的首请求会
        //    302 到 /?token=…，dsh 收到后才 Set-Cookie。**如果那张 cookie 带 Secure 属性，
        //    WebView 在 http:// 下会把它丢掉** → 每个请求都回到「没 cookie」→ 无限 302 循环。
        //    （手机浏览器能正常打开，说明它不带 Secure；这里留个记号，真撞上别去别处找。）
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, false)   // 同源请求，不需要
        }

        web.webViewClient = object : WebViewClient() {
            /**
             * B1（T9-b）—— 外链外抛。
             *
             * 症状（实测，不是推断）：消息里的 http/https 链接、以及**检索来源引用**，
             * dsh 都渲染成 `target="_blank"`（`refs` 侧实证：`D8({url,label})` →
             * `<a target="_blank" rel="noopener noreferrer">`）。而 WebView 在
             * `setSupportMultipleWindows(false)`（默认）下**不开新窗口** —— 它把这类导航
             * 当普通导航处理，于是**原地把 dsh 顶掉**：点一下链接就回不到聊天界面了，
             * 得按返回键才行。
             *
             * 规则只有一条：**同源留 WebView，异源外抛**。
             *   · 同源 = 与 `AppConfig.baseUrl` 的 scheme + host + port 三者全等。
             *     ⚠️ 这一条**不能省也不能放宽**：bridge 对首请求会 302 到 `/?token=…`，
             *     那是同源跳转，必须留在 WebView 里，否则 token 注入当场断掉。
             *   · 其余交给系统（浏览器 / 邮件应用）。dsh 那一页原地不动。
             *
             * ⚠️ 用 `startActivity` + 捕获 `ActivityNotFoundException`，**不要先 resolveActivity**：
             *     Android 11+ 的包可见性会过滤 `resolveActivity` 的结果（那才需要 manifest 写
             *     `<queries>`），但**不影响 `startActivity`** —— 隐式 intent 由系统代解析。
             *     这样既不用加 `<queries>`，也不会因为 resolve 失败而**静默什么都不发生**。
             */
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val uri = request.url
                if (isSameOrigin(uri)) return false

                val intent = Intent(Intent.ACTION_VIEW, uri)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                return try {
                    startActivity(intent)
                    Log.i(TAG, "外链外抛：已交给系统（scheme=${uri.scheme}）")
                    true
                } catch (_: ActivityNotFoundException) {
                    Toast.makeText(
                        this@MainActivity,
                        "没有应用能打开这个链接（${uri.scheme}）",
                        Toast.LENGTH_SHORT
                    ).show()
                    true   // 仍然吞掉：交回 WebView 只会把 dsh 顶掉，那更糟
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                Log.i(TAG, "onPageFinished: $url")
                // T9-d8：页面每次加载完 = 重试预算**重置**（页面自己的重载 / 302 补 token
                // 都会走到这里）。钩子是随 SPA 起来的，可能在 onPageFinished 之后才挂上，
                // 所以这里不直接下结论，交给 tryNavigate 去试、去重试。
                pageReady = true
                navTries = 0
                if (wantSessionId != null) tryNavigate()
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                val desc = error.description?.toString() ?: "?"
                Log.e(TAG, "onReceivedError: ${request.url}  code=${error.errorCode}  $desc")
                if (request.isForMainFrame) {
                    showFatal(
                        "加载失败\n\n${request.url}\n\n[$desc]\n\n" +
                            "按顺序查：\n" +
                            "1. PC 上 node tools\\ts-bridge.mjs 起了吗\n" +
                            "2. 手机 Tailscale 登录了吗（要看着是同一个 tailnet）\n" +
                            "3. PC 上 3080 在监听吗"
                    )
                }
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                // SPA 起不来时，真正的理由通常只在这几行里（未捕获异常 / 缺 API /
                // CORS / 语法错误）。全部转发到 logcat，TAG = AgentWatch。
                Log.i(
                    TAG,
                    "console[${msg.messageLevel()}] ${msg.message()} @${msg.sourceId()}:${msg.lineNumber()}"
                )
                return true
            }

            /**
             * B2 —— 文件选择。
             *
             * 症状（改之前）：dsh 输入框左下角那个「添加文件或调用指令」点下去**静默无反应**。
             * 原因：WebView 自己不会弹文件选择器，它只是**把这件事交给宿主 App** ——
             * 没人接这个回调，页面就永远等在那里（`onShowFileChooser` 默认返回 false）。
             *
             * ⚠️ 用 `startActivityForResult` / `onActivityResult` 这套老 API，**不是** androidx 的
             *    `registerForActivityResult`：本工程至今**零依赖、纯 framework API**，
             *    为这一个回调引整棵 androidx 依赖树不值当。（会有 deprecation 警告，不影响构建。）
             *
             * ⚠️ 必须**记住**这个 callback 并保证最后一定回一次值 —— 见 `finishFileChooser`。
             */
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                // 上一次还没回值就又来一次（用户连点两下）：先把旧的收掉。
                // 不收的话旧的那个 callback 永远悬着，那一次选择就永远不返回。
                finishFileChooser(null)

                pendingFileCallback = filePathCallback

                val intent = try {
                    fileChooserParams.createIntent()
                } catch (_: Exception) {
                    Intent(Intent.ACTION_GET_CONTENT).setType("*/*")
                }
                return try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(intent, REQ_FILE_CHOOSER)
                    true
                } catch (_: ActivityNotFoundException) {
                    // `createIntent()` 会带上页面写的 `accept`（比如 image/*），
                    // 而这台机器上可能恰好没有任何 App 声明能接这个类型。
                    // 回落一次「什么都能选」，比直接失败强。
                    Log.w(TAG, "文件选择器 createIntent 无人能接，回落通用 GET_CONTENT")
                    try {
                        @Suppress("DEPRECATION")
                        startActivityForResult(
                            Intent(Intent.ACTION_GET_CONTENT).setType("*/*"),
                            REQ_FILE_CHOOSER
                        )
                        true
                    } catch (_: ActivityNotFoundException) {
                        finishFileChooser(null)
                        Toast.makeText(
                            this@MainActivity, "这台手机没有能选文件的应用", Toast.LENGTH_SHORT
                        ).show()
                        false
                    }
                }
            }
        }

        val entry = AppConfig.baseUrl(this)
        Log.i(TAG, "loadUrl $entry")
        web.loadUrl(entry)

        // ---- T9-d：常驻监听 ----
        // 先要权限再拉服务：反过来的话，首次启动那几秒的通知会被系统直接丢掉，
        // 而用户此刻看到的正好是「说好的常驻通知呢」。
        ensureNotifPermission()
        if (AppConfig.watchEnabled(this)) {
            WatchService.start(this)
        } else {
            Log.i(TAG, "watchEnabled=false（用户点过「停止监听」）→ 不拉起服务")
        }

        // ---- T9-d8：**冷启动**也是从审批通知点进来的（App 已经被划掉 / 从没开过）----
        // 放在最后：此处 `web.loadUrl` 已经发出去，跳转由 onPageFinished 接着做
        // （那之前 pageReady 还是 false，tryNavigate 会按兵不动、也不耗重试次数）。
        intent?.getStringExtra(EXTRA_SESSION_ID)?.takeIf { it.isNotEmpty() }?.let { requestSession(it) }
    }

    /**
     * 通知权限（API 33+ 才要）。
     *
     * ⚠️ **每次都问**，而不是问过一次就记下来。理由：如果是「不再询问」，
     *    系统会立刻返回 denied，代价只是这一次调用；反过来若只问一次，用户过后在
     *    系统设置里把权限打开/关掉，我们就永远跟不上，而症状是「一切看起来正常，
     *    就是不来通知」。
     */
    private fun ensureNotifPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_NOTIF) return
        val ok = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        Log.i(TAG, "POST_NOTIFICATIONS granted=$ok")
        if (!ok) {
            // 没这个权限，前台服务照样跑，但**通知一条都不会显示**（Android 13 起
            // 前台服务的通知也归它管）—— 表现就是「开着，但永远不响」，必须当场说破。
            Toast.makeText(
                this,
                "没有通知权限：待批审批不会弹通知。\n设置 → 应用 → AI 监看 → 通知",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    // ========================================================================
    // B2 —— 文件选择（用户从系统选择器回来）
    // ========================================================================

    /**
     * ⚠️ **无论用户选没选，都必须回一次值。**
     *
     * 取消 / 返回键 / 选择器自己崩了，都会走到这里且 `data == null` —— 那时要回的是
     * **`null` 而不是空数组**：回 `null` 才是「没选」，WebView 会据此把页面里那个
     * file input 复位；回空数组在页面看来是「选了 0 个文件」，状态机不一定复位。
     * 这就是 `finishFileChooser` 存在的唯一理由 —— 别把这条路径散在几处各写一遍。
     */
    @Deprecated("零依赖工程，用不了 androidx 的 ActivityResultLauncher —— 见 onShowFileChooser 注释")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILE_CHOOSER) return

        // `parseResult` 是官方给的解析口：多选（ClipData）、单选、取消，它都处理了，
        // 自己拆 `data.data` 只能覆盖单选那一种。
        val picked =
            if (resultCode == Activity.RESULT_OK && data != null)
                WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            else null
        Log.i(TAG, "文件选择返回：resultCode=$resultCode，选中 ${picked?.size ?: 0} 个")
        finishFileChooser(picked)
    }

    /** 回值并清掉悬着的 callback。**恰好回一次** —— 空转是安全的（见字段注释）。 */
    private fun finishFileChooser(value: Array<Uri>?) {
        val cb = pendingFileCallback ?: return
        pendingFileCallback = null
        cb.onReceiveValue(value)
    }

    /**
     * targetSdk 35+ 强制 edge-to-edge，内容会铺到状态栏 / 导航栏底下。
     * 不补这层内边距，dsh 顶部的标题栏会被状态栏压住 —— 那看起来像「App 坏了」，
     * 其实是我们的锅，会污染 D18 的结论。所以宁可多这十行。
     */
    private fun applySystemBarInsets(view: WebView) {
        view.setOnApplyWindowInsetsListener { v, insets ->
            val top: Int
            val bottom: Int
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
                )
                top = bars.top
                bottom = bars.bottom
            } else {
                @Suppress("DEPRECATION")
                top = insets.systemWindowInsetTop
                @Suppress("DEPRECATION")
                bottom = insets.systemWindowInsetBottom
            }
            v.setPadding(0, top, 0, bottom)
            insets
        }
        // 监听器是在 setContentView 之后挂的，首次 insets 可能已经派发过了 ——
        // 主动要一次，免得内边距永远没机会应用。
        view.requestApplyInsets()
    }

    /**
     * 这个 URL 是不是「我们自己那台 PC」。
     *
     * 比 scheme + host + port **三者全等**，不能只比 host：
     * 手机上 3080 是 bridge、3081 是 dsh，只比 host 会把两个口混为一谈。
     *
     * ⚠️ `Uri.port` 在 URL 省略端口时返回 **-1**，得按 scheme 的默认口补齐
     *    （`http` → 80、`https` → 443）—— 否则 `http://100.x.y.z/` 会和
     *    `http://100.x.y.z:3080/` 被误判成同源，把该外抛的留下来。
     */
    private fun isSameOrigin(uri: Uri): Boolean {
        val base = Uri.parse(AppConfig.baseUrl(this))
        fun portOf(u: Uri): Int =
            if (u.port != -1) u.port else if (u.scheme.equals("https", true)) 443 else 80
        return uri.scheme.equals(base.scheme, true) &&
            uri.host.equals(base.host, true) &&
            portOf(uri) == portOf(base)
    }

    /** 主框架挂了就换成一块纯文本，免得对着白屏猜 */
    private fun showFatal(text: String) {
        val tv = TextView(this).apply {
            setPadding(48, 120, 48, 48)
            setTextColor(Color.parseColor("#B00020"))
            textSize = 13f
            this.text = text
        }
        setContentView(tv)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) {
            web.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onResume() {
        super.onResume()
        // 前台不弹审批通知 —— 屏幕上已经有 dsh 原生那张审批卡了。
        // 顺带把之前弹过的撤掉（服务下一轮轮询也会撤，但这里立刻生效）。
        WatchService.appVisible = true
    }

    override fun onPause() {
        super.onPause()
        WatchService.appVisible = false
        // 把 cookie 落盘，免得进程被杀后又要重新走一遍 token 注入。
        // ⚠️ Service 那侧读的就是这张 cookie —— 所以这里 flush 不只是省一次重登录，
        //    它还是「App 被杀掉之后通知还能继续来」的前提。
        CookieManager.getInstance().flush()
    }

    /**
     * 点通知进来走这条（launchMode=singleTask，Activity 还活着时不会重走 onCreate）。
     *
     * T9-d8：带上 `sessionId` 的（＝**审批通知**）就切过去；不带的（＝**常驻那条
     * 「监听中」**、或用户自己从桌面图标进来）**什么都不做** —— 不许把用户从当前
     * 会话挪走，这是验收的负例。
     */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)   // 让 getIntent() 跟最新这条一致，免得进程重建时又翻出上一次的会话
        val sid = intent?.getStringExtra(EXTRA_SESSION_ID)
        Log.i(TAG, "onNewIntent（多半是从通知点进来的）sessionId=$sid")
        if (sid.isNullOrEmpty()) return
        requestSession(sid)
    }

    // ------------------------------------------------------------ T9-d8 会话直达

    /** 记下「要去哪个会话」，然后开始试。 */
    private fun requestSession(id: String) {
        Log.i(TAG, "要去会话 $id（pageReady=$pageReady）")
        wantSessionId = id
        navTries = 0
        tryNavigate()
    }

    /**
     * 试一次：问页面「你那个直达钩子在不在，在就切过去」。
     *
     * 🔴 **一次不成就重试**，不能打完一枪就走，理由见 `pageReady` 那段注释。
     *
     * ⚠️ 页面那头返回的是**字符串**（`'opened'` / `'bad-id'` / `'no-service'` / `'error'`），
     *    不是布尔 —— 这样这一侧才分得清「钩子还没有，等等再试」和「钩子在但切不过去」。
     *    `evaluateJavascript` 的回调给的是 **JSON 字面量**（`"opened"`，自带引号）。
     */
    private fun tryNavigate() {
        val sid = wantSessionId ?: return
        if (isDestroyed || isFinishing) {
            wantSessionId = null
            return
        }
        if (!pageReady) return   // 不出手，也**不耗次数**（见 pageReady 的注释）

        // ⚠️ 用 `JSONObject.quote` 生成 JS 字符串字面量，**绝不自己拼引号**：
        //    id 里只要混进一个引号或反斜杠，手拼的那版就是语法错误，而页面报回来的
        //    多半只是一句没有下文的求值异常 —— 正是我们最不想再见到的失败样子。
        val js = "(function(){try{return typeof window.__agentwatchOpenSession==='function'" +
            "?window.__agentwatchOpenSession(${JSONObject.quote(sid)}):'no-hook'}" +
            "catch(e){return 'error'}})()"
        web.evaluateJavascript(js) { raw ->
            val v = raw?.trim()?.trim('"')
            if (v == "opened") {
                Log.i(TAG, "已切到会话 $sid")
                wantSessionId = null
                return@evaluateJavascript
            }
            navTries++
            if (navTries >= NAV_MAX_TRIES) {
                // 放弃**是安全的**：停在当前页面，就是 T9-d 那时的行为，不比从前差。
                // 但一定要留下日志 —— 「有时能直达有时不能」全靠这一行查。
                Log.w(TAG, "会话直达放弃：试了 $navTries 次，最后一次=$v（停在当前页面）")
                wantSessionId = null
                return@evaluateJavascript
            }
            ui.postDelayed({ tryNavigate() }, NAV_RETRY_MS)
        }
    }

    override fun onDestroy() {
        // 重试链是挂在主线程队列上的，Activity 没了就得断掉，不然会拿着一个
        // 已销毁的 WebView 继续 evaluateJavascript。
        ui.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    // ⚠️ companion **不能是 private**：`EXTRA_SESSION_ID` 要跨类给 `WatchService` 用
    //    （原来这里是 `private companion object`，加常量时当场编译报错）。
    //    改成逐个成员收口 —— 对外只露那一个常量。
    companion object {
        private const val TAG = "AgentWatch"
        private const val REQ_NOTIF = 1001

        /** B2 —— 文件选择器的 requestCode。跟上面那个**必须不同**，否则回调走岔。 */
        private const val REQ_FILE_CHOOSER = 1002

        /** 点通知要去的会话（T9-d8）。`WatchService.openApp` 那头塞进来。 */
        const val EXTRA_SESSION_ID = "com.agentwatch.app.SESSION_ID"

        /** 页面就绪后最多试 20 次 × 700ms ≈ 14 秒 —— 够 SPA 起完 + 插件激活。 */
        private const val NAV_MAX_TRIES = 20
        private const val NAV_RETRY_MS = 700L
    }
}
