package com.agentwatch.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.widget.TextView
import android.widget.Toast

/**
 * T9-b / B3 —— 设置页。
 *
 * 它回答的是「**连不上了，我该看哪儿**」，不是「调参数」。
 * 起因见 layout 头部那段注释：地址做成可编辑与「只许连这一个 IP」不能同真，
 * 而真正的痛点是不知道去查哪儿。所以这一页几乎全是**字**。
 *
 * ⚠️ 入口有三个，缺一不可：
 *   ① 常驻通知的「设置」动作（主入口 —— 用户平时就是看着那条通知）
 *   ② 桌面图标长按 → 快捷方式（备 —— 通知没了也得进得来）
 *   ③ 这个 Activity 自己（从哪个入口进都行）
 *
 * ⚠️ 零依赖：纯 framework，没有 androidx，所以没有 AppCompatActivity / Fragment。
 *    Activity + setContentView 就够了，这一页没有任何需要兼容层的东西。
 */
class SettingsActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        // 地址从 AppConfig 取，**不在布局里写死** —— 免得将来真改了地址，
        // 页面上显示的还是旧的（那比不显示更坏）。
        findViewById<TextView>(R.id.addr).text = AppConfig.baseUrl(this)

        findViewById<TextView>(R.id.back).setOnClickListener { finish() }

        // 版本号：文档里反复要用它回答「手机上跑的是哪一版」，
        // 而每次都得 adb 去问太费事 —— 直接摆在这一页。
        findViewById<TextView>(R.id.version).text = versionLine()

        // ---- 两个「一键跳系统设置」----
        // 这两条是上面自查清单第 5 条的直接解药：把「去设置里翻」缩短成一次点击。
        findViewById<TextView>(R.id.btn_notif).setOnClickListener {
            openSystemPage(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            )
        }
        findViewById<TextView>(R.id.btn_appinfo).setOnClickListener {
            openSystemPage(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:$packageName"))
            )
        }
    }

    /**
     * ⚠️ 必须 catch：国内 ROM 偶尔会拿掉某一个系统设置页（或被「应用冻结」之类挡下），
     *    不接就是一个闪退 —— 而用户此刻正在「连不上、来查原因」，
     *    再撞上闪退，这一页就彻底失去意义了。
     */
    private fun openSystemPage(intent: Intent) {
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            Log.w(TAG, "系统设置页打不开：${intent.action}")
            Toast.makeText(this, "这台手机没有这个设置页，请在「设置」里手动找", Toast.LENGTH_LONG)
                .show()
        }
    }

    private fun versionLine(): String = try {
        val pi = packageManager.getPackageInfo(packageName, 0)
        val code = if (android.os.Build.VERSION.SDK_INT >= 28) pi.longVersionCode else pi.versionCode.toLong()
        "AI 监看 ${pi.versionName}（${code}）"
    } catch (_: Exception) {
        // 取不到就算了 —— 这行是给人看的，别为了它让整页崩掉
        "AI 监看"
    }

    private companion object {
        private const val TAG = "AgentWatch"
    }
}
