package com.agentwatch.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.webkit.CookieManager
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * T9-d —— 常驻监听：**让手机在 App 不在屏幕上时，也能在 PC 产生待批审批的那一刻知道**。
 *
 * 两条通知，各管一头（`CH_ONGOING` / `CH_APPROVAL`）：
 *   · 常驻条：**服务活着的证据**（监听中 / 连接失败 / 未登录），点开是 App，
 *     带「保活设置」和「停止监听」两个动作。
 *   · 审批条：一条待批一张，点开是 App 里那张 dsh 原生审批卡。批/拒之后**自动撤掉**。
 *
 * ---------------------------------------------------------------------------
 * 🔴 为什么是 `specialUse` 而不是 `dataSync`
 *
 * Android 15 起 `dataSync` 类前台服务有 **6 小时/天** 的上限（超了就掐），
 * `specialUse` 没有。这东西的设计目标就是**全天挂着**，用 dataSync 等于自带一个
 * 定时炸弹。（`specialUse` 要过审是 Google Play 的事；本 App 侧载自用，不进 Play。）
 *
 * ---------------------------------------------------------------------------
 * 🔴 节流在协议里，不在客户端
 *
 * 首轮 `?wait=0` 拿快照 → 之后 `?wait=25` 挂住，**有变化才回**。别写 `while(true) poll()`，
 * 那是忙等（插件那侧的注释里记着 2026-10-14 踩到的那个真缺陷：连着 6 次请求 0.4 秒内
 * 全返回，一秒几十次）。所以这里循环体里**没有** sleep —— 挂住本身就是节流。
 * 只有**失败**才需要自己退避（那种情况下请求是立刻返回的）。
 */
class WatchService : Service() {

    private lateinit var nm: NotificationManager
    private val main = Handler(Looper.getMainLooper())

    private var worker: Thread? = null
    private val client = PendingClient()

    @Volatile private var running = false
    @Volatile private var isForeground = false

    /**
     * 已经发过审批通知的 id → 用来「不在表里了就撤掉」。
     *
     * 🔴 **必须加锁**：它同时被**轮询线程**（applyItems）和**主线程**（「停止监听」那条路径）
     * 碰。撞出来的 `ConcurrentModificationException` 不是"小毛病" —— Android 上
     * **非主线程的未捕获异常一样会杀掉整个进程**，表现就是「点一下停止监听，App 没了」。
     * 下面四个访问器是唯一的入口，别绕过它们直接用集合。
     */
    private val posted = LinkedHashSet<String>()
    private val postedLock = Any()
    private var lastOngoing: String? = null

    /**
     * T10：**「AI 这次干到哪了」**，直接来自快照的 `progress` 段。`null` ＝ 没在跑。
     *
     * ⚠️ 只有轮询线程读写它，但 `ongoingText` 那条路会被主线程碰（「停止监听」也走
     *    `setOngoing`），所以标 `@Volatile` 而不是加锁 —— 这只有「看见旧值」和
     *    「看见新值」两种结果，没有需要原子性的复合操作。
     */
    @Volatile private var progress: Progress? = null

    /**
     * T9-e：**表里有几条待批** —— 唯一用途是让常驻条那句自己改口。
     *
     * 🔴 **为什么非得这样**（2026-10-14 晚真机实测）：这台 ROM 有个系统级的
     *    「会响的通知自动聚合成一段」机制（`Aggregate_AlertingSection`）——
     *    审批通知本身完全正常（importance=4、会震、标题正文都对），
     *    但锁屏和通知栏上**首屏是个折叠摘要，要展开才看得见「需要你批准」**。
     *    ⚠️ 这不是我们写坏了：QQ / 微信在同一个 `Aggregate_AlertingSection` 里待遇相同。
     *    ⇒ 系统那一层改不动，就**换一个我们完全控制得住的地方喊** —— 常驻条。
     *    它一直在、importance 虽低但 `mUserVisibleTaskShown=true`，锁屏也显示正文。
     *
     * ⚠️ **前台时保持 0**：那时屏幕上就是 dsh 原生审批卡，再喊一遍等于同一个信息
     *    画两遍（T3a 那条教训的又一变体）。
     */
    @Volatile private var pendingCount: Int = 0

    /**
     * 快照到达那一刻，「已经跑了多久」的**服务端口径**（毫秒）。
     *
     * 🔴 **为什么要有这个中转**：`sinceTs` 和 `Snapshot.now` 都是 **PC 的钟**，
     *    而手机和 PC 的钟不一定同步（实测过的常识，不是理论担忧）。拿手机自己的
     *    `System.currentTimeMillis() − sinceTs` 会算出负数或者好几年。
     *    所以：**服务端算差值，本地只负责往里加流逝的时间**。
     *
     * `-1` ＝ 这次快照里没有进度，[progressMillis] 直接返回 null。
     */
    @Volatile private var elapsedAtSyncMs: Long = -1L

    /**
     * 上面那个差值对应的**本地**时刻，用 [SystemClock.elapsedRealtime]（开机以来的毫秒）。
     *
     * ⚠️ 刻意不用 `System.currentTimeMillis()`：那个会被系统对时/用户改时间拽着跳，
     *    跳一次「已跑」就会突然变成负数或者几个小时。`elapsedRealtime` 只单调向前。
     */
    @Volatile private var syncedAtElapsed: Long = 0L

    private fun postedSnapshot(): List<String> = synchronized(postedLock) { posted.toList() }
    private fun postedAdd(id: String) { synchronized(postedLock) { posted.add(id) } }
    private fun postedRemove(id: String) { synchronized(postedLock) { posted.remove(id) } }

    /** 取走全部并清空 —— 撤通知时要的正是「看一眼、然后清掉」这一整个动作。 */
    private fun postedDrain(): List<String> = synchronized(postedLock) {
        val all = posted.toList()
        posted.clear()
        all
    }

    override fun onCreate() {
        super.onCreate()
        nm = getSystemService(NotificationManager::class.java)
        createChannels()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 🔴 不管来的是哪个 action，**都先把前台立起来**：用 startForegroundService 起的
        //    服务必须在 5 秒内调 startForeground，否则系统直接崩我们
        //    （RemoteServiceException: Context.startForegroundService() did not then call
        //    Service.startForeground()）。「点停止」那条路径也照做 —— 否则「停止监听」
        //    会变成一次闪退，而且只在真机上、只在服务没在跑的时候闪。
        if (!isForeground) {
            startForegroundCompat(buildOngoing(OngoingState.STARTING))
            isForeground = true
        }

        if (intent?.action == ACTION_STOP) {
            Log.i(TAG, "收到停止指令")
            AppConfig.setWatchEnabled(this, false)
            // 用户明确说「别看了」→ 把待批通知也一起撤掉（留着它们就等于还在催他）
            for (id in postedDrain()) nm.cancel(approvalNotifId(id))
            stopSelf()
            return START_NOT_STICKY
        }

        AppConfig.setWatchEnabled(this, true)
        startWorker()
        // START_STICKY：被系统回收后自己回来（回来时 intent 是 null，走的就是这条路）。
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        client.cancel()          // 断开挂着的长轮询；光 interrupt() 断不开 socket 读
        worker?.interrupt()
        worker = null
        isForeground = false
        // 刻意**不**撤待批通知：进程被系统回收 ≠ 那些审批被处理了。
        // 通知留着仍然有用（点开就是 App）；服务重启后按 id 重发一遍，不会重复堆积。
        super.onDestroy()
    }

    // ------------------------------------------------------------------ 轮询

    private fun startWorker() {
        if (worker?.isAlive == true) return
        running = true
        worker = Thread({ loop() }, "agentwatch-poll").apply {
            isDaemon = true
            start()
        }
    }

    private fun loop() {
        var first = true
        var backoff = 0L
        Log.i(TAG, "轮询线程起来，目标 ${AppConfig.pendingUrl(this)}")

        while (running) {
            val cookie = readCookie()
            if (cookie.isNullOrEmpty()) {
                // 没凭据就别去敲了：必然 401，白烧电白烧流量。
                // 正常情况下这是**首次启动的头几秒**：cookie 由 WebView 打开首页时铸出来
                // （见 PendingClient 头注释），所以「等一会儿自己就好了」。
                setOngoing(OngoingState.NEED_AUTH)
                sleepQuietly(AUTH_RETRY_MS)
                continue
            }

            val wait = if (first) 0 else POLL_WAIT_SEC
            when (val r = client.poll(AppConfig.pendingUrl(this), wait, cookie)) {
                is PollResult.Ok -> {
                    first = false
                    backoff = 0L
                    applySnapshot(r.snapshot)
                    applyItems(r.snapshot.items)
                    setOngoing(OngoingState.OK)
                }
                is PollResult.NeedAuth -> {
                    first = false
                    Log.w(TAG, "未认证（HTTP ${r.code}）—— cookie 可能过期或还没铸出来")
                    setOngoing(OngoingState.NEED_AUTH)
                    sleepQuietly(AUTH_RETRY_MS)
                }
                is PollResult.Failed -> {
                    // 只有失败才需要退避：成功那条路径由服务端挂住，本来就是节流的
                    backoff = if (backoff == 0L) BACKOFF_MIN_MS else (backoff * 2).coerceAtMost(BACKOFF_MAX_MS)
                    Log.w(TAG, "轮询失败：${r.why} → ${backoff}ms 后重试")
                    setOngoing(OngoingState.OFFLINE)
                    sleepQuietly(backoff)
                }
            }
        }
        Log.i(TAG, "轮询线程退出")
    }

    /**
     * 拿 WebView 那张 cookie。
     *
     * 🔴 走主线程：`CookieManager` 是 WebView 的一部分，WebView 的初始化是有线程要求的。
     *    这是轮询线程，不是主线程 —— 所以要 post 过去等一小下。这点等待比在真机上
     *    偶发一个「不知道为什么就是不发通知」便宜得多。
     */
    private fun readCookie(): String? {
        if (Looper.myLooper() == Looper.getMainLooper()) return cookieNow()
        var out: String? = null
        val latch = CountDownLatch(1)
        val queued = main.post {
            out = cookieNow()
            latch.countDown()
        }
        if (!queued) return null
        return if (latch.await(2, TimeUnit.SECONDS)) out else null
    }

    private fun cookieNow(): String? = try {
        CookieManager.getInstance().getCookie(AppConfig.baseUrl(this))
    } catch (t: Throwable) {
        // 进程被 START_STICKY 拉回来、而 Activity 从没起过时，WebView 可能压根没加载成功
        // （被停用 / 数据目录被清）。返回 null 会让上面显示「未登录 · 请打开一次 App」，
        // 那是准确且可诊断的，不是失败。
        Log.w(TAG, "读 WebView cookie 失败：${t.javaClass.simpleName}: ${t.message}")
        null
    }

    // ------------------------------------------------------------------ 通知

    /**
     * T10：把快照里的进度段接上来，并把「已跑多久」换算成**本地基准**。
     *
     * 🔴 两句话就是全部要点：
     *    ① `sinceTs` 与 `now` **是同一个钟（PC 的）** ⇒ 差值只能由服务端这两个数算出来，
     *       不能拿手机自己的钟去减 `sinceTs`（两个钟不一定同步，会算出负数或好几年）。
     *    ② 拿到的差值是「**快照那一刻**」的；之后靠**本地单调钟**往前加 ——
     *       于是「已跑 X」会随时间自己走，**不需要另起定时器**：轮询每 25 秒回来一次，
     *       文案里的秒数变了，`setOngoing` 那道「文案没变就别白敲系统」的守卫自然放行。
     */
    private fun applySnapshot(s: Snapshot) {
        val p = s.progress
        progress = p
        val since = p?.sinceTs
        // `now <= 0` ＝ 老服务端（没有这个键）⇒ 那时 progress 也必然是 null，一起兜住。
        if (p == null || since == null || s.now <= 0L) {
            elapsedAtSyncMs = -1L
            return
        }
        elapsedAtSyncMs = (s.now - since).coerceAtLeast(0L)
        syncedAtElapsed = SystemClock.elapsedRealtime()
    }

    /** 已经跑了多久；没有进度时返回 null。 */
    private fun progressMillis(): Long? {
        if (progress == null || elapsedAtSyncMs < 0L) return null
        return elapsedAtSyncMs + (SystemClock.elapsedRealtime() - syncedAtElapsed)
    }

    private fun applyItems(items: List<PendingApproval>) {
        val now = HashSet<String>(items.size)
        for (p in items) now.add(p.id)

        // ① 已经不在表里的 → 撤。（包括**用户在电脑上批的** —— 那正是手机该安静下来的时刻。）
        for (id in postedSnapshot()) {
            if (id !in now) {
                nm.cancel(approvalNotifId(id))
                postedRemove(id)
            }
        }

        // ② App 在前台：屏幕上已经有 dsh 原生审批卡了，通知是重复的（T3a 的教训换个载体
        //    又来了一遍 —— 同一个信息在同一时刻画两遍）。全撤，并且**这轮不发**。
        if (appVisible) {
            for (id in postedDrain()) nm.cancel(approvalNotifId(id))
            pendingCount = 0
            return
        }

        // ③ 剩下的每轮都重发一次。
        //    刻意的：能被划掉的提醒 = 能被弄丢的提醒，而这个东西丢了意味着**电脑那头
        //    的 agent 一直卡着没人知道**。配合 setOnlyAlertOnce(true)，重发不响不震。
        for (p in items) {
            nm.notify(approvalNotifId(p.id), buildApproval(p))
            postedAdd(p.id)
        }
        // ④ 常驻条那句改口（见 pendingCount 的注释）。放在循环后 —— `items` 就是这轮
        //    表里的全集，跟 ③ 发出去的那批严格一致。
        pendingCount = items.size
    }

    private fun setOngoing(state: OngoingState) {
        val text = ongoingText(state)
        if (text == lastOngoing) return   // 文案没变就别白敲一次系统
        lastOngoing = text
        nm.notify(ONGOING_ID, buildOngoing(state))
    }

    private fun ongoingText(state: OngoingState): String = when (state) {
        OngoingState.STARTING -> "启动中…"
        // 待批**压过**进度：agent 卡在审批上时本来就没有进度可看，而这条是唯一
        // 需要用户动手的事 —— 有事要他管的时候还在报「监听中」，正是要修的那个病。
        OngoingState.OK -> if (pendingCount > 0) {
            "有 $pendingCount 条待你批准"
        } else {
            progressText() ?: "监听中 · ${hhmm()} 已同步"
        }
        OngoingState.OFFLINE -> "连接失败 · 检查 Tailscale"
        OngoingState.NEED_AUTH -> "未登录 · 请打开一次 App"
    }

    /**
     * T10：有进度就用进度那行（「正在改文件 · D:\x.txt · 已跑 1 分 20 秒」），
     * 没有才退回「监听中 · HH:MM 已同步」。
     *
     * ⚠️ 刻意**不**把两者拼起来（「监听中 · 正在改文件 …」）：通知栏那一行就这么大，
     *    而 AI 正在干活时「监听中」是废话 —— 这条通知还在、还每轮刷新，本身就说明在监听。
     */
    private fun progressText(): String? {
        val p = progress ?: return null
        val ms = progressMillis() ?: return null
        return ApprovalText.progressLine(p, ms)
    }

    private fun buildOngoing(state: OngoingState): Notification {
        // 标题也改口：折叠摘要那一眼看到的往往就是标题（`Aggregate_AlertingSection`
        // 挡在前面，正文要展开才露出来）—— 改正文不改标题，等于在用户看不见的地方喊。
        val alerting = state == OngoingState.OK && pendingCount > 0
        val b = Notification.Builder(this, CH_ONGOING)
            .setSmallIcon(R.drawable.ic_watch)
            .setContentTitle(if (alerting) "⚠️ 需要你批准" else "AI 监看")
            .setContentText(ongoingText(state))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(openApp())
            .addAction(notifAction("设置", openSettings()))
            .addAction(notifAction("停止监听", stopWatch()))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // 默认（API 31+）会为了省电把前台通知压后最多 10 秒才露头。
            // 这条通知是「服务真的活着」的唯一证据，必须立刻可见。
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        return b.build()
    }

    /**
     * T9-h：这条通知现在回答三个问题 —— **谁在请求**（标题）/ **多危险、对什么动手**
     * （折叠正文）/ **为什么**（展开正文）。三段的分工与理由写在 [ApprovalText] 里。
     *
     * ⚠️ `setOnlyAlertOnce(true)` 在下面 —— 它现在多担了一份职责：会话标题**晚到**时
     *    我们会用同一个通知 id 重发一次（插件为此专门唤醒了一轮长轮询），
     *    有它才不会为了一句标题把用户再震一遍。
     */
    private fun buildApproval(p: PendingApproval): Notification {
        val nid = approvalNotifId(p.id)
        return Notification.Builder(this, CH_APPROVAL)
            .setSmallIcon(R.drawable.ic_watch)
            .setContentTitle(ApprovalText.title(p))
            .setContentText(ApprovalText.collapsed(p))
            .setStyle(Notification.BigTextStyle().bigText(ApprovalText.detail(p)))
            .setContentIntent(openApp(nid, p.sessionId))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setWhen(if (p.at > 0) p.at else System.currentTimeMillis())
            .build()
    }

    private fun createChannels() {
        nm.createNotificationChannel(
            NotificationChannel(CH_ONGOING, "监听状态", NotificationManager.IMPORTANCE_LOW).apply {
                description = "常驻状态条：监听中 / 连接失败 / 未登录"
                setShowBadge(false)
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_APPROVAL, "待批审批", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "电脑上有操作在等你批准时提醒"
                enableVibration(true)
            }
        )
    }

    private fun startForegroundCompat(n: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // API 34 起必须在 manifest 声明了 type 才有权在这里指定 type。
            startForeground(ONGOING_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(ONGOING_ID, n)
        }
    }

    // ------------------------------------------------------------------ 小工具

    /**
     * `addAction(int icon, …)` 自 API 23 起废弃了 —— 动作按钮早就不画图标。
     * icon 传 null 就是「没有图标」的正式写法（旧的恒传 0 只是碰巧等价）。
     */
    private fun notifAction(title: String, pi: PendingIntent): Notification.Action =
        Notification.Action.Builder(null, title, pi).build()

    /**
     * 打开 App。
     *
     * T9-d8：`sessionId` 非空就**带上它** —— 那条审批属于哪个会话。点开之后由
     * `MainActivity` 负责真的切过去（它那边要等页面和插件钩子就绪，所以那段逻辑在那边）。
     *
     * ⚠️ `sessionId` 为空时**什么也不带** —— 这正是验收的**负例**：
     *    点常驻那条「监听中」**不许**把用户从当前会话挪走。
     *    （常驻条走的是 `openApp()` 无参调用，天然就落在这条上。）
     *
     * ⚠️ PendingIntent 的身份只看 requestCode + `filterEquals`（**不含 extra**），
     *    而审批条的 requestCode 是每条一个（`approvalNotifId`）⇒ 各自的 extra 互不串。
     */
    private fun openApp(requestCode: Int = 0, sessionId: String? = null): PendingIntent {
        val i = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (!sessionId.isNullOrEmpty()) i.putExtra(MainActivity.EXTRA_SESSION_ID, sessionId)
        return PendingIntent.getActivity(this, requestCode, i, PI_FLAGS)
    }

    /**
     * 打开设置页。
     *
     * 🔴 **这里原来是跳系统的「电池优化白名单」页 —— 那是个假按钮**（2026-10-14 改）：
     *    实测这台 vivo 上 AOSP 的电池优化白名单**根本拦不住后台被杀**
     *    （真正管用的是 i 管家里的「后台运行 / 后台高耗电 / 自启动」三件套，外加别划卡片）。
     *    点它 = 用户照做了一遍、以为设好了、问题照旧 —— 比没这个按钮还坏。
     *    现在跳我们自己的设置页，那一页把这三条和自查清单都写清楚了。
     *
     * ⚠️ 别忘了同步改按钮文字（`buildOngoing` 里那个 addAction）—— 名不副实一样会误导。
     */
    private fun openSettings(): PendingIntent {
        val i = Intent(this, SettingsActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(this, 1, i, PI_FLAGS)
    }

    private fun stopWatch(): PendingIntent {
        val i = Intent(this, WatchService::class.java).setAction(ACTION_STOP)
        return PendingIntent.getService(this, 2, i, PI_FLAGS)
    }

    private fun sleepQuietly(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            // 不清 interrupt 标志、也不往外抛：onDestroy 里已经把 running 置 false 了，
            // 外层 while 下一轮就退出。（在这里再 interrupt() 一次会让后续 sleep 立刻
            // 抛异常 → 变成忙等。）
        }
    }

    private fun hhmm() = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())

    private fun approvalNotifId(id: String) = APPROVAL_ID_BASE + (id.hashCode() and 0x00FFFFFF)

    private enum class OngoingState { STARTING, OK, OFFLINE, NEED_AUTH }

    companion object {
        private const val TAG = "AgentWatch"

        const val ACTION_START = "com.agentwatch.app.START"
        const val ACTION_STOP = "com.agentwatch.app.STOP"

        private const val CH_ONGOING = "watch-ongoing"
        private const val CH_APPROVAL = "watch-approval"

        private const val ONGOING_ID = 1
        /** 审批通知 id 的基数：和 ONGOING_ID 岔开，且 `and 0x00FFFFFF` 保证不越界撞上。 */
        private const val APPROVAL_ID_BASE = 100_000

        /** 服务端最长挂 60s（插件里的 `HARD_MAX_WAIT_SEC`），取 25 留足余量。 */
        private const val POLL_WAIT_SEC = 25

        private const val BACKOFF_MIN_MS = 1_000L
        private const val BACKOFF_MAX_MS = 30_000L

        /** 「没凭据」不是故障（首次启动的头几秒就是这样），重试间隔取短的。 */
        private const val AUTH_RETRY_MS = 10_000L

        private const val PI_FLAGS = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

        /**
         * App 是否在屏幕上。由 `MainActivity.onResume/onPause` 维护。
         * 放在这里而不是 MainActivity 里，是因为读它的是本服务的轮询线程 ——
         * 让写方和读方待在同一处，比跨类去读一个 Activity 的静态字段清楚。
         */
        @Volatile var appVisible = false

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, WatchService::class.java).setAction(ACTION_START))
        }
    }
}
