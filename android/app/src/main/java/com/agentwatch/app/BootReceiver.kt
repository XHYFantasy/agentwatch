package com.agentwatch.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * T9-e/C —— 开机自启 / 装包后自启。
 *
 * 为什么需要它：手机重启后进程全没了，前台服务**不会自己回来**。不加这个 receiver，
 * 用户每次重启都得手动开一次 App，否则就是**静默失联** —— 通知栏干干净净，
 * 看不出任何异常，最难查的那一类。这是「装一次就不用管它」缺的最后一块。
 *
 * ⚠️ 它**尊重用户意图**：点过通知上「停止监听」的人（`AppConfig.watchEnabled == false`）
 *    重启后不会被重新拉起来。（`watchEnabled` 本来就是为这个用途存的。）
 *
 * ⚠️ 它**救不了 force-stop**：被强行停止（划卡片 / 一键清理 / 设置里强停）的包处于
 *    stopped 状态，而这个状态**跨重启保留** ⇒ 连 BOOT_COMPLETED 都收不到。
 *    那条路只能靠「压根没有卡片可划」来堵，见 manifest 里 MainActivity 的
 *    `excludeFromRecents`。两个改动是一对，缺一个都还留着一条静默失联的路。
 *
 * ⚠️ Android 12+ 默认禁止从后台启动前台服务。`BOOT_COMPLETED` 与
 *    `MY_PACKAGE_REPLACED` 是明文豁免的几条系统广播之一 —— 换成别的广播就会崩在
 *    `startForegroundService` 那一行。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (!AppConfig.watchEnabled(context)) {
            Log.i(TAG, "用户关过监听，$action 不自启")
            return
        }
        try {
            WatchService.start(context)
            Log.i(TAG, "自启监听: $action")
        } catch (e: Exception) {
            // 刻意吞掉。开机广播里抛异常会弹「应用已停止」，是纯粹的伤害、零收益 ——
            // 真失败了，用户会以「通知栏一直不响」的形式感知到，那才是对的可见性。
            Log.w(TAG, "自启失败: $action ${e.message}")
        }
    }

    private companion object {
        const val TAG = "AgentWatchBoot"
    }
}
