package com.agentwatch.app

import android.content.Context

/**
 * T9-d —— 配置收口。
 *
 * 为什么要有它：T9-a 把地址硬编码在 MainActivity 里，那是**当时刻意的**（那一步只验
 * D18「13MB 的 SPA 能不能在系统 WebView 里跑起来」，变量越少结论越干净）。
 * 现在多了第二个消费者（Service 的轮询），再各写一份常量迟早会对不上 ——
 * 而「手机上什么都没发生」是这套东西里最难查的故障，不值得用一个常量去换。
 *
 * ⚠️ 改地址有两条路，优先级不同：**设置页改的**（存 prefs）压过**构建时注入的**默认值。
 *    设置页是 T9-b 加的，见 `SettingsActivity`；默认值怎么来见下面 `DEFAULT_BASE_URL`。
 */
object AppConfig {

    private const val PREFS = "agentwatch"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_WATCH = "watch_enabled"

    /**
     * 默认入口 = 你那台跑 dsh 的电脑上的监听口。
     *
     * ⚠️ 值是**构建时注入**的（`app/build.gradle` 的 `buildConfigField`，源头是
     *    `android/local.properties` 的 `agentwatch.host` / `agentwatch.port`），
     *    **不在这里写死** —— 理由见 build.gradle 顶部那段：写死了别人 clone 下来就永远连不上。
     *    顺带说明为什么这里从 `const` 改成了普通 `val`：BuildConfig 是编译产物，
     *    常量表达式引用不了它（`const val x = BuildConfig.Y` 编不过）。
     *
     * 链路：手机 → <host>:<port> →（ts-bridge 纯 TCP 透传）→ PC 127.0.0.1:3081。
     * 用户可以在设置页改，改完以存进 SharedPreferences 的那份为准（见 `baseUrl`）。
     */
    val DEFAULT_BASE_URL: String = BuildConfig.BASE_URL

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 结尾保证带 `/`，否则拼出来会变成 `http://host:3080agentwatch/pending`。 */
    fun baseUrl(ctx: Context): String {
        val raw = prefs(ctx).getString(KEY_BASE_URL, null)?.trim()
        val v = if (raw.isNullOrEmpty()) DEFAULT_BASE_URL else raw
        return if (v.endsWith("/")) v else "$v/"
    }

    fun setBaseUrl(ctx: Context, url: String) {
        prefs(ctx).edit().putString(KEY_BASE_URL, url.trim()).apply()
    }

    /**
     * 待批审批端点。路径由**插件那侧**决定（`plugin\agentwatch-card\index.js` 的
     * `DEFAULT_PATH`，可被 `cordis.patch.yml` 的 `pending.path` 覆盖）—— 两处必须一致，
     * 对不上就是干干净净一个 404，不会有任何提示。
     */
    fun pendingUrl(ctx: Context): String = baseUrl(ctx) + "agentwatch/pending"

    /** 用户点过「停止监听」就记下来，免得下次开 App 又给他拉起来。 */
    fun watchEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_WATCH, true)

    fun setWatchEnabled(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean(KEY_WATCH, on).apply()
    }
}
