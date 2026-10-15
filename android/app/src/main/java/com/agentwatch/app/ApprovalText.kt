package com.agentwatch.app

/**
 * 通知栏上的**措辞**。
 *
 * 分工与 T3/T5 同一条线：插件（宿主半）只把原料送出来
 * （toolName / reason / command / target），措辞全在客户端这侧。
 *
 * ⚠️ 「工具名 → 中文动词」这张小表是**我们自己的**，理由写清楚，免得日后被当成
 *    重复建设撤掉：
 *    · dsh 确实有一份（`refs\dsh-ui-tool\lib\client.js:83` 的 wire 工具名表，
 *      会话流里 tool-call 行上的「运行命令 / 读取」就是它给的）；
 *    · 但那一份在**客户端 bundle** 里，渲染目标是 **dsh 的会话流**；
 *    · **通知栏它到不了** —— 通知是 Android 系统画的，dsh 根本没有这个载体。
 *   ⇒ 这是新载体必需的，不是重复建设（正好是 §4 硬闸门第三问要的「原生没有」）。
 *   覆盖不到的工具**显示原名，不猜**。
 */
private val TOOL_ZH = mapOf(
    "pwsh" to "运行命令",
    "bash" to "运行命令",
    "shell" to "运行命令",
    "write" to "写文件",
    "edit" to "改文件",
    "read" to "读文件",
)

private const val LINE_MAX = 64

/** 进度行里那个文件/命令的宽度上限 —— 见 `progressLine` 里为什么它比 [LINE_MAX] 短。 */
private const val WHAT_MAX = 30

/** 会话标题在通知标题栏里的宽度上限 —— 见 [ApprovalText.title]。 */
private const val SESSION_MAX = 16

// ============================================================================
// T9-h 风险色标 —— 回应用户那句「**不放按钮，告诉他有什么东西请求访问**」
// ============================================================================
//
// 🔴 **这套规则在项目里有两份，改一处必须改两处**：
//    · WebView 卡里那份：`plugin\agentwatch-card\client.js` 的 `assess()` —— **6 条**
//    · 这里（App 通知那份）—— **5 条**
//    为什么必须重写一遍：那一份跑在 WebView 里，结果**送不到原生通知**
//    （要 `evaluateJavascript` 把值捞出来，而 App 在后台时 WebView 恰恰是冻的）。
//
// ⚠️ **少的第 6 条是「代码里有危险写法」**（WebView 那份判 `args.code`）—— payload 里没这格。
//    为什么不补：`run_code` 跑危险代码时**必然先被沙箱拦下**，模型提权重试就带上
//    `sandbox_permissions`，被下面第 1 条兜住。⇒ 实际影响为零，不值得为它多开一格契约。
//
// 保守原则照抄 client.js（T3g 立的）：只认「能说清为什么」的几条，说不清一律归低风险 ——
// 宁可少标，也不要乱报；乱报一次这个色标就没人信了。
private val DANGEROUS = Regex(
    """(^|\s)(rm|del|rmdir|format|shutdown|diskpart)\b|Remove-Item|Stop-Computer|Restart-Computer|-Recurse\b|--force\b|-rf\b""",
    RegexOption.IGNORE_CASE,
)
private val SHELL_TOOLS = setOf("bash", "pwsh")
private val CODE_TOOLS = setOf("run_code")

/**
 * 一次风险判定的结果。
 *
 * @param emoji 折叠态的前缀。**放最前面** —— 折叠态是唯一一眼可见的地方（Android 通知
 *              折叠时只给两行），危险性得排在「对象是谁」前面。
 * @param why   为空串表示没什么好说的（常规操作），拼行时**整段略去**，不留一个孤零零的 `·`。
 */
data class Risk(val emoji: String, val label: String, val why: String)

/** 判一条审批的风险。顺序即优先级 —— **放宽沙箱排第一**，因为它是唯一"本来会被拦下"的那种。 */
fun riskOf(p: PendingApproval): Risk {
    val sp = p.sandboxPermissions
    if (!sp.isNullOrBlank()) return Risk("🔴", "需要放宽沙箱", "要提到 $sp")
    val cmd = p.command
    if (!cmd.isNullOrBlank() && DANGEROUS.containsMatchIn(cmd)) {
        return Risk("🔴", "命令里有危险写法", "含删除 / 格式化 / 关机一类操作")
    }
    if (p.toolName == "write" || p.toolName == "edit") {
        return Risk("🟡", "会写磁盘", "这一步会真的改到文件")
    }
    if (p.toolName in SHELL_TOOLS) return Risk("🟡", "会执行命令", "会在你机器上跑一条命令")
    if (p.toolName in CODE_TOOLS) return Risk("🟡", "会执行代码", "会在你机器上跑一段代码")
    return Risk("🟢", "常规操作", "")
}

object ApprovalText {

    /** 拿不到会话名时用的兜底标题（见 [title]）。 */
    const val TITLE = "远程监看 · 需要你批准"

    /** 拿得到会话名时的前缀，形如 `需要批准 · PowerShell 依次运行三条延时命令`。 */
    private const val TITLE_PREFIX = "需要批准"

    /**
     * 通知标题 = **谁在请求**。
     *
     * 用户原话是「不放按钮，**告诉他有什么东西请求访问**」—— 而「谁在请求」正是那个
     * 「什么东西」：多任务并行时，两条审批通知长得一模一样是没法用的。
     *
     * ⚠️ 会话名是**异步**来的（`session/title` 由小模型生成，可能比审批晚到）
     *    ⇒ 拿不到就退回 [TITLE] 那个固定身份串，**不编**。
     *    晚到时插件会唤醒一次长轮询，这个函数被重新调用，通知标题当场刷新
     *    （`setOnlyAlertOnce(true)` 保证不会重响一遍）。
     * ⚠️ 裁到 [SESSION_MAX]：**我们自己裁比让系统 ellipsize 好** —— 系统会腰斩在半个词上，
     *    而 `clip` 至少留个省略号，看得出是"被裁了"而不是"标题就这么长"。
     */
    fun title(p: PendingApproval): String {
        val s = p.sessionTitle?.trim()?.takeIf { it.isNotEmpty() } ?: return TITLE
        return "$TITLE_PREFIX · ${clip(s, SESSION_MAX)}"
    }

    /**
     * 通知的正文那一行，形如 `写文件 → D:\agentwatch.txt`。
     * 取不到对象就只留动词 —— **不编**。
     *
     * 优先用 `target`（短、准），没有才退回命令行首行：`pwsh` 这种工具没有
     * `path` 参数，信息全在命令原文里。
     */
    fun headline(p: PendingApproval): String {
        val verb = TOOL_ZH[p.toolName] ?: p.toolName?.takeIf { it.isNotBlank() } ?: "调用工具"
        val what = p.target?.takeIf { it.isNotBlank() }
            ?: p.command?.takeIf { it.isNotBlank() }?.let { firstLine(it) }
            ?: return verb
        return "$verb → ${clip(what)}"
    }

    /**
     * **折叠态**的正文：风险 emoji + [headline]。
     *
     * 折叠态只有两行，所以这里只放两样东西：多危险、对什么动手。
     * 「是谁在请求」在标题栏（[title]），"为什么"在展开态（[detail]）。
     */
    fun collapsed(p: PendingApproval): String = "${riskOf(p).emoji} ${headline(p)}"

    /**
     * **展开态**的正文，四段：
     *
     * ```
     * 🔴 需要放宽沙箱 · 要提到 danger-full-access     ← 多危险（一眼决定要不要停下手里的事）
     * 写文件 → D:\agentwatch-t9e.txt                  ← 对什么动手
     * escalate sandbox to danger-full-access: …       ← 为什么（dsh 给的 reason，模型写的）
     * ```
     *
     * 顺序是有理由的：**危险性 > 对象 > 原因**。会话名不在这里 ——
     * 它在标题栏（[title]），展开后标题照样看得见，再抄一行纯属重复。
     *
     * ⚠️ 后两段**取不到就整段不出现**，不留空行 —— 与「不编」同一条纪律。
     */
    fun detail(p: PendingApproval): String {
        val lines = ArrayList<String>(3)
        lines += riskLine(p)
        lines += headline(p)
        p.reason?.trim()?.takeIf { it.isNotEmpty() }?.let { lines += it }
        return lines.joinToString("\n")
    }

    /** 风险那行的文字形态：`🔴 需要放宽沙箱 · 要提到 danger-full-access`（`why` 为空则不带尾巴）。 */
    private fun riskLine(p: PendingApproval): String {
        val r = riskOf(p)
        return if (r.why.isEmpty()) "${r.emoji} ${r.label}" else "${r.emoji} ${r.label} · ${r.why}"
    }

    /**
     * T10：常驻通知正文里那行**进度**，形如 `正在改文件 · D:\x.txt · 已跑 1 分 20 秒`。
     *
     * @param elapsedMs 已经跑了多久。**由调用方从 `Snapshot.now − Progress.sinceTs` 起算、
     *                  再按本地流逝累加**（见 `WatchService.applySnapshot`）。
     *                  这个函数刻意**不碰任何时钟** —— 理由写在 `Progress.sinceTs` 那条注释里：
     *                  手机和 PC 的钟不一定同步，时钟只在一个地方读才不会有第二个口径。
     */
    fun progressLine(p: Progress, elapsedMs: Long): String {
        val head = progressVerb(p.toolName)
        // 对象取 target 优先、退回命令行首行 —— 与 headline 同一条优先级，别搞两套。
        val what = p.target?.takeIf { it.isNotBlank() }
            ?: p.command?.takeIf { it.isNotBlank() }?.let { firstLine(it) }
        val tail = elapsedText(elapsedMs)
        // ⚠️ target 单独剪短：整行末尾的「已跑 X 分」才是这行的重点，
        //    被一条长路径挤掉就本末倒置了。
        return if (what == null) "$head · $tail" else "$head · ${clip(what, WHAT_MAX)} · $tail"
    }

    /**
     * 「正在 …」。
     *
     * ⚠️ 表就是上面那张 [TOOL_ZH]，**只是加个「正在」**：审批行写的是「写文件」（名词化的动作），
     *    进度这行要的是进行时。另起一张表 ⇒ 同义词迟早对不上（改了一处忘了另一处）。
     * 认不出的工具**显示原名**（「正在 web_fetch」），不猜 —— 与 [headline] 同一条纪律。
     */
    private fun progressVerb(toolName: String?): String {
        val zh = TOOL_ZH[toolName]
        if (zh != null) return "正在$zh"
        return toolName?.takeIf { it.isNotBlank() }?.let { "正在 $it" } ?: "正在思考"
    }

    /**
     * 「已跑 X 分 Y 秒」。
     *
     * 🔴 **只报已用的时间，不报进度百分比** —— 模型这一步还要跑多久**没人知道**，
     *    画一根会自己走的进度条就是编。这是 T10-c 明列的「不做」。
     */
    private fun elapsedText(ms: Long): String {
        val total = (ms / 1000).coerceAtLeast(0)
        val m = total / 60
        val s = total % 60
        return if (m > 0) "已跑 $m 分 $s 秒" else "已跑 $s 秒"
    }

    /**
     * 刻意**不带** T3 那两行「允许一次 → …／拒绝 → …」的后果说明：
     * 通知上**没有决策按钮**（带按钮是 T9-g，已留档不做），
     * 一个没有决策点的位置配一段决策说明，只是噪音。
     */
    private fun firstLine(s: String) = s.lineSequence().firstOrNull { it.isNotBlank() }?.trim() ?: s.trim()

    private fun clip(s: String, max: Int = LINE_MAX) =
        if (s.length > max) s.take(max - 1) + "…" else s
}
