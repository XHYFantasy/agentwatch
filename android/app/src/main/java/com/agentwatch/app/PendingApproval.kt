package com.agentwatch.app

import org.json.JSONObject

/**
 * 一条待批审批。字段 = 插件那份契约，**不多不少**
 * （`plugin\agentwatch-card\index.js` 文件头的「端点契约」一节，T9-c 定、T9-d 补了
 * `command` / `target`、T9-d8 补了 `sessionId`）。
 *
 * ⚠️ 除 `id` / `at` 外**全部可空** —— 契约明写两个摘要字段「取不到就是 null，不编」，
 *    所以下面任何一处都不许假定非空。`sessionId` 也是这个待遇。
 */
data class PendingApproval(
    val id: String,
    /**
     * T9-d8：**这条审批属于哪个会话**。
     *
     * 🔴 为什么非有不可：dsh 的审批卡是**按会话**渲染的，而手机点通知进来时停在
     *    「上次浏览的那个会话」—— T9-d 六条真机验收的第 ③ 条正是这么败的
     *    （提醒没错、卡也在、切过去就能批，但**点开开错了门**）。
     *
     * ⚠️ 可空：插件那侧取不到就是 `null`，此时**照常出通知**，只是点开不做跳转
     *    （＝退回 T9-d 的行为，不比那时更差）。
     */
    val sessionId: String?,
    /**
     * T9-h：会话的**人话名字**（`sessionId` 是 UUID，上屏等于没上）。
     *
     * 来源是 dsh 的 `session/title` 事件，⚠️ **异步** —— 由小模型生成，可能比审批晚到。
     * ⇒ 插件那边是**快照时现场 join** 的，所以这一格**一开始是 null、下一轮长轮询就有了**；
     *    晚到的标题会让插件唤醒一次长轮询，通知标题随即被刷新（`setOnlyAlertOnce` 保证不重响）。
     */
    val sessionTitle: String?,
    val toolName: String?,
    val callId: String?,
    val reason: String?,
    val command: String?,
    val target: String?,
    /**
     * T9-h：`args.sandbox_permissions` 原文（如 `danger-full-access`），没有就是 `null`。
     *
     * 它是 dsh **提权审批的指纹**（实测当天 11 次审批 100% 是它）⇒ 通知上那个 🔴 色标的
     * **主判据**。⚠️ 存的是**原料**（英文枚举），中文在 [ApprovalText.riskOf] 里拼。
     */
    val sandboxPermissions: String?,
    val at: Long,
)

/**
 * T10：**「AI 这次干到哪了」**。
 *
 * 回答的问题是「**手机没打开的时候，AI 在干嘛**」—— 会话页内原生那行
 * （`ProcessGroupHeader`：正在读取文件 / 正在运行命令 + 流光文本）**只在页面里看得见**，
 * 而 T10 的场景恰恰是页面不在前台。
 *
 * ⚠️ 除 `sessionId` 外**全部可空**，而且**整段都可能是 `null`**（`Snapshot.progress`）：
 *    AI 没在跑的时候服务端就送 `null` ⇒ 任何一处都不许假定非空。
 *
 * ⚠️ `toolName` 是 **wire 名**（`write` / `pwsh`），中文由 [ApprovalText] 翻 ——
 *    与审批那条完全同一张表（服务端只送原料，措辞在这侧，见插件文件头那条纪律）。
 */
data class Progress(
    val sessionId: String?,
    val turn: Int?,
    val step: Int?,
    val toolName: String?,
    val target: String?,
    val command: String?,
    /**
     * **本轮（turn）开始**的时刻（服务端钟）。
     *
     * 🔴 不是「这次工具调用」的时刻 —— 要回答的是「AI **这次**干多久了」，
     *    所以它整轮里保持不变。
     * 🔴 **算「已跑多久」必须用 [Snapshot.now] 减它**：两个字段同一个钟。
     *    手机和 PC 的钟不一定同步 ⇒ 拿手机自己的 `System.currentTimeMillis()`
     *    去减会算出负数或好几年。见 [WatchService.applySnapshot]。
     */
    val sinceTs: Long?,
)

/** 一次快照的完整内容（`{ now, pending: [...], progress: {...}|null }`）。 */
data class Snapshot(
    /**
     * **服务端的钟**（毫秒）。存在的唯一理由是给 `sinceTs` 做减法 —— 别拿它当"现在几点"。
     * ⚠️ 老服务端（T10 之前）没有这个键 ⇒ 兜 0，此时 [Progress] 也必然不存在。
     */
    val now: Long,
    val items: List<PendingApproval>,
    val progress: Progress?,
)

/**
 * 解析一次快照。单条坏掉只丢那一条，不整包失败。
 *
 * ⚠️ **向后兼容是真的**：老服务端没有 `progress` 键 ⇒ [JSONObject.optJSONObject] 返回
 *    `null` ⇒ `progress = null`，一路走到「监听中 · HH:MM 已同步」。反过来，
 *    老 App 对上新服务端时多出来的键会被 `optJSONArray("pending")` 无视。
 *    两边都不用改。
 */
fun parseSnapshot(body: String): Snapshot {
    val root = JSONObject(body)
    val arr = root.optJSONArray("pending")
    val out = ArrayList<PendingApproval>(arr?.length() ?: 0)
    if (arr != null) {
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            // id 是撤通知的唯一钥匙，没有它这条对我们毫无用处
            val id = o.optString("id").takeIf { it.isNotEmpty() } ?: continue
            out += PendingApproval(
                id = id,
                sessionId = o.optNullableString("sessionId"),
                sessionTitle = o.optNullableString("sessionTitle"),
                toolName = o.optNullableString("toolName"),
                callId = o.optNullableString("callId"),
                reason = o.optNullableString("reason"),
                command = o.optNullableString("command"),
                target = o.optNullableString("target"),
                sandboxPermissions = o.optNullableString("sandboxPermissions"),
                at = o.optLong("at", 0L),
            )
        }
    }
    return Snapshot(
        now = root.optLong("now", 0L),
        items = out,
        progress = parseProgress(root.optJSONObject("progress")),
    )
}

private fun parseProgress(o: JSONObject?): Progress? {
    if (o == null) return null
    return Progress(
        sessionId = o.optNullableString("sessionId"),
        turn = o.optNullableInt("turn"),
        step = o.optNullableInt("step"),
        toolName = o.optNullableString("toolName"),
        target = o.optNullableString("target"),
        command = o.optNullableString("command"),
        sinceTs = o.optNullableLong("sinceTs"),
    )
}

/**
 * 🔴 `optString(key)` 在「键存在但值是 JSON `null`」时返回**字符串 `"null"`**，不是空串。
 *    直接用它，通知栏上就会规规矩矩地写一行「null」。必须先 `isNull()` 判一次。
 */
internal fun JSONObject.optNullableString(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

/**
 * 同上的数字版。⚠️ 用 `opt(key) is Number` 判，不要用 `optInt(key)` ——
 * 后者的默认值会把「键不存在」「值是 null」「值是字符串」全糊成同一个 `0`，
 * 而 `0` 在这里是**合法值**（第 0 轮/第 0 步）⇒ 分不出来就编了一个数，正是契约里禁止的「编」。
 */
internal fun JSONObject.optNullableInt(key: String): Int? =
    (opt(key) as? Number)?.toInt()

internal fun JSONObject.optNullableLong(key: String): Long? =
    (opt(key) as? Number)?.toLong()
