/**
 * Host 半 —— T9-c：审批 pending 端点（`GET /agentwatch/pending`）
 *
 * ============================================================================
 * 干什么：把「现在有哪些审批开着」变成一个手机能轮询的 HTTP 端点。
 *
 * 为什么需要（不是想当然，是实证过的）：
 *   App 切到后台后，WebView 里的客户端半会被系统冻结 ⇒ 「有审批来了」这件事
 *   **没有任何浏览器内的办法送出去**。所以必须有个**进程内**的东西替手机记着。
 *   dsh 自己**没有**这个查询接口 —— `ApprovalService` 的公开面只有
 *   `request()` / `decide()` / `setPolicy()` / `setApprovalPolicy()`，没有 pending 查询
 *   （`refs\dsh-user-approval\lib\index.js` 方法清单）。它内部算了（`invariant.js`
 *   的 `trace.pending`），但没暴露 ⇒ **只能我们自己从事件流里维护一张表**。
 *
 * 所以本半做三件事：
 *   ① `ctx.on('session/event', …)` 增量维护 pending 表（asked 加 / decided 删）
 *   ② `ctx.webServer.register()` 注册一个 exact 路由
 *   ③ 支持 `?wait=<秒>` 长轮询：**挂住等「表变化」**，有变化或超时才回
 *
 * ---------------------------------------------------------------------------
 * 端点契约（T9-d 的 App 照这个写，别猜）：
 *
 *   GET <path>?wait=0     → 立刻回当前快照「首轮用这个」
 *   GET <path>?wait=<秒>  → 挂住，直到 pending 表**有任何变化**（新增**或**删除）或超时
 *   两者都返回 200
 *     `{ now, pending: [{ id, sessionId, sessionTitle, toolName, callId, reason,
 *                         command, target, sandboxPermissions, at }],
 *        progress: { sessionId, turn, step, toolName, target, command, sinceTs } | null }`
 *
 *   ⭐ `command` / `target` 是 T9-d 加的两个**原料**字段 —— 手机通知上那行
 *      「写文件 → D:\x.txt」要的原料就是它们（只有 `reason` 说不清「到底对什么动手」）：
 *        · `command` —— shell 工具（pwsh / bash）的 `args.command` 原文；别的工具为 null
 *        · `target`  —— `args.path` 或 `args.file_path`（**按 dsh 自己那份
 *                       `FILE_PATH_KEYS = ["path","file_path"]` 的顺序**，见下）
 *      ⚠️ **两个都可能为 null**（工具没这两个键 / 参数不是合法 JSON / `tool/call`
 *         比 `approval/asked` 晚到）⇒ **App 必须能在缺字段时照常出通知**，不许崩、不许空白。
 *
 *   ⭐ `sessionId` 是 T9-d8 加的一格：**这条审批属于哪个会话**。
 *      为什么非有不可：dsh 的审批卡是**按会话**渲染的，而手机点通知进来时停在
 *      「上次浏览的那个会话」—— T9-d 六条真机验收的第 ③ 条正是这么败的
 *      （提醒没错、卡也在、切过去就能批，但**点开开错了门**）。通知带上它，点开才能直达。
 *      取值来源：`ctx.on('session/event', (session, event) => …)` 的**第一个参数**，
 *      属主自己就是这么取的（`refs\dsh-security\dsh-sandbox-policy\lib\index.js:146`
 *      的 `{ sessionId: session.id }`）。
 *      ⚠️ 同样**可能为 null** ⇒ App 必须照常出通知，只是点开时不做跳转
 *         （退回今天的行为，不比现在更差）。
 *
 *   ⭐ `sessionTitle` / `sandboxPermissions` 是 T9-h 加的两格 —— 回应用户那句
 *      「**不放按钮，告诉他有什么东西请求访问**」：`sessionId` 是 UUID，直接上屏等于没上；
 *      而「要放宽沙箱」和「读个文件」在通知栏上原本长得一模一样重。
 *
 *      · `sessionTitle` —— 会话的**人话名字**。来源：`session/title` 事件
 *        （`data = { title, messageSeqs, source }`，本机实测报文见档案）。
 *        ⚠️ **一个会话来两条**：先 `source.kind === 'fallback'`（截用户消息头几个字，
 *        可能是「用 pwsh 工具依次跑 3 条命令，」这种半截话），后 `source.kind === 'provider'`
 *        （小模型生成的，就是页面标题里那个）⇒ **后到覆盖先到，无条件 set**。
 *        🔴 **它是异步生成的，可能比审批晚到** ⇒ 快照时**现场 join**，不塞进 pending 条目里
 *        （塞进去＝把「标题还没生成」那一刻永久钉死在那条审批上）。
 *        ⚠️ 取不到给 `null`，**不编** —— App 照常出通知，只是标题行不显示。
 *
 *      · `sandboxPermissions` —— `args.sandbox_permissions` 原文（如 `danger-full-access`），
 *        没有就是 `null`。它是 dsh **提权审批的指纹**：实测当天 11 次审批 **100% 是它**。
 *        App 拿它判「这条是不是要放宽沙箱」→ 风险色标 🔴。
 *        🔴 **只送原料**：中文措辞（「需要放宽沙箱 · 要提到 danger-full-access」）
 *        在 App 的 `ApprovalText` 里拼 —— 与 `command` / `target` 同一条纪律。
 *
 *   🔴 **风险判定规则住在两处，改一处必须改两处**（写下来免得下次当成 bug）：
 *        · WebView 卡里那份：`plugin\agentwatch-card\client.js` 的 `assess()`（6 条规则）
 *        · App 通知那份：`android\...\ApprovalText.kt` 的 `riskOf()`
 *      为什么不能只有一处：客户端半跑在 **WebView** 里，它的 JS 结果**送不到原生通知**
 *      —— 那要 `evaluateJavascript` 把结果捞出来，而 App 在后台时 WebView 恰恰是冻的。
 *
 *   ⭐ `progress` 是 T10 加的一段（**「AI 这次干到哪了」**）：
 *       `{ sessionId, turn, step, toolName, target, command, sinceTs }`，**没在跑时是 `null`**。
 *       · 回答的问题：**用户没打开 App 的时候**，AI 在干嘛。会话页内原生那一行
 *         （`ProcessGroupHeader`：正在读取文件 / 正在运行命令 + 流光文本）**只在页面里看得见**，
 *         而 T10 的场景恰恰是页面不在前台 ⇒ 常驻通知上得有一份。
 *       · 🔴 **只送原料，措辞在 App 里做**（与 `command`/`target` 同一条纪律）：
 *         `toolName` 是 wire 名（`write` / `pwsh`），「正在改文件」这种中文是 **App 的
 *         `ApprovalText` 翻的** —— 那里已经有同一张映射表，复用；在这里再写一套就是翻两遍。
 *       · 🔴 **`sinceTs` 是「本轮（turn）开始」的时刻，不是「这次工具调用」的时刻** ——
 *         通知要回答的是「AI **这次**干多久了」。配套的硬约束见下。
 *       · 🔴 **算「已跑多久」必须用服务端 `now` 减 `sinceTs`**：两个字段同一个钟（PC 的）。
 *         手机和 PC 的钟不一定同步 ⇒ 拿手机自己的 `Date.now()` 去减会算出荒谬的值
 *         （负数或好几年）。正确的做法是 `now - sinceTs` 当初始值，之后用本地流逝累加。
 *       · ⚠️ **只维护一份、记「最近活跃的那个会话」**（有意的简化，见字段声明处）。
 *       · ⚠️ **唤醒有 3 秒节流**（`PROGRESS_WAKE_MIN_MS`）：进度变化也会唤醒长轮询，
 *         但 `tool/call` 会连着来，不节流就是忙等换了个形态。⇒**通知上的进度最长滞后一个轮询周期**。
 *       · ⚠️ **它和 `pending` 相互独立**：没有待批审批时 `progress` 照样有值（AI 在干活但没问问题），
 *         有审批挂着时也可能 `progress` 是 null（审批等在你面前、AI 早停了）。**App 别把两者绑死。**
 *
 *   · 唤醒来自 `approval/asked`（新审批）与 `approval/decided`（被批掉了，
 *     包括**用户在电脑上批的** —— 那正是手机该撤通知的时刻）
 *   · 🔴 **首轮务必 `wait=0`** —— 拿初始快照；用 `wait=30` 会在「表非空但没变化」
 *     时空等满 30 秒才拿到它
 *   · 推荐形态：`r = poll(wait=0)` → 之后循环 `poll(wait=30)`，按 `id` 去重发通知。
 *     **不需要客户端自己做退避** —— 节流在协议里（这是 2026-10-14 修掉的那个忙等坑）
 *
 * ---------------------------------------------------------------------------
 * 🔴 安全：为什么 handler 里必须自己调 `ctx.connection.admit(req)`
 *
 * `dsh-host-webserver` **自身没有任何认证** —— 属主 README 原文：「不提供服务器级
 * TLS、认证或来源策略」。认证在 `dsh-client-connection`，而且**只有 `/api` 路由与
 * Gateway 的 WS 升级会调 `admit`**（`refs\dsh-client-connection\README.zh.md:45`）。
 *
 * ⇒ **我们自己 register 的路由默认不过 admit，也就是对任何能到达该端口的人敞开。**
 *   不调它就等于亲手开一个无认证的端点。所以：
 *     · 有 `admit` → 用它的裁决（401 / 403 直接透传）
 *     · 没有 `ctx.connection` → **不注册路由**（fail-closed）
 *   绝不依赖「反正前面有 ts-bridge 会拦」—— 那是靠代理实现的安全，不是 dsh 的能力。
 *   （与 `tools\ts-bridge.mjs` 的 `--patch` 同一条纪律：拿不到收口清单就拒绝启动。）
 *
 * ---------------------------------------------------------------------------
 * 🔴 遗留硬约束（T5 时代立的，仍然生效）：
 *   - **本文件不许有任何 `import`。** 插件是 `link:` 进 profile 的，真实路径在 D 盘，
 *     Node 从真实路径往上走找不到任何 `@deepseek-ai/*`（profile 的 node_modules 里
 *     只有 `@local` 和 `.pnpm`）⇒ 纯 ESM、零依赖。
 *   - **绝不声明 `export const Config`** —— 声明了就必须 import schemastery，
 *     一失败插件激活直接挂。裸收 `config`，代码里兜默认值。
 *   - **`apply()` 里不要包 try/catch**（吞异常会把「激活失败」变成静默失效）；
 *     但**监听器与 handler 里必须 try/catch**。
 *   - handler 的**任何路径都必须走到 `res.end()`** —— 否则连接悬挂，手机端长轮询
 *     会一直等（这在长轮询里比在普通路由里严重得多）。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 本半**只送原料，不做翻译**。
 *
 *   翻译是 T3 客户端半在做的事（`client.js` 里那套风险分级 / 后果说明）。在这里
 *   另起一套规则 = **同一个东西画两遍** —— 正是 T3a 白做一整张卡的教训。
 *   所以 T9-d 的两个新字段**只做「取值」，不做「措辞」**：
 *     取值（`command` / `target`）＝原料，和 `reason` 一样原样带出；
 *     措辞（「写文件 → …」这行怎么写、工具名翻成什么中文）＝在 App 里做。
 *
 *   ⚠️ 与「不打命令原文」那条红线的关系（2026-10-14，T9-d）：
 *     红线原文是「**日志**只打工具名 / 是否命中缓存 / 耗时，**不打命令原文**」——
 *     管的是**日志**，不是这条端点。而这条端点的对面是**同一台手机**，它自己的
 *     WebView 里 dsh 原生审批卡**本来就显示着同一条命令原文**
 *     （`ApprovalCommand`，T3h 实测 `$ Set-Content -Path 'D:\…'`），且过 `admit` 闸门。
 *     ⇒ 在这里带出去**没有多泄露一个字节**。**日志那条纪律不变，仍然照旧。**
 */

const DEFAULT_PATH = '/agentwatch/pending';
const HARD_MAX_WAIT_SEC = 60; // 无论配置写多大都不超过这个数：长轮询会占住一条 TCP

export function apply(ctx, config) {
  const cfg = isObj(config) ? config : {};
  const pendingCfg = isObj(cfg.pending) ? cfg.pending : {};

  if (pendingCfg.enabled === false) {
    log('pending 端点：配置里 enabled=false，不注册');
    return;
  }

  const routePath =
    typeof pendingCfg.path === 'string' && pendingCfg.path.startsWith('/')
      ? pendingCfg.path
      : DEFAULT_PATH;

  const maxWaitSec =
    Number.isFinite(pendingCfg.maxWaitSec) && pendingCfg.maxWaitSec > 0
      ? Math.min(pendingCfg.maxWaitSec, HARD_MAX_WAIT_SEC)
      : HARD_MAX_WAIT_SEC;

  // ---- 依赖的服务：用 ctx.inject 等它们到位 ----
  //
  // 🔴 为什么是 `ctx.inject([...], cb)` 而不是模块级 `export const inject = [...]`：
  //
  //   先踩到的坑：直接在 `apply` 里写 `ctx.webServer` →
  //     `Error: cannot get property "webServer" without inject`（整个插件不激活）。
  //   cordis 的服务是沿 fiber 链**按需解析**的，`inject` 是「等它到位」的机制
  //   （`refs\_cordis-lib\index.js:676` 那个 proxy get 守卫）。
  //
  //   两种 inject 的区别（`refs\dsh-skills\...\practices.md:20` 两条路都提了）：
  //     · 模块级 `export const inject` → 服务缺失时**插件整个不激活**
  //     · `ctx.inject(deps, cb)`        → 只把**回调**挂起，插件本体照常激活
  //
  //   🔴 桌面端正属于「服务缺失」那一种：Electron 走 `file://` + IPC，
  //      **没有 webserver**（`refs\dsh-host-webserver\README.zh.md` 概述明写）。
  //      用模块级 inject ⇒ 桌面端这个插件不激活 —— 而它的**客户端半正是 T3 那张卡**，
  //      会不会被一起带走**没验过**。用 `ctx.inject` 就没有这个风险：
  //      webServer 不出现 ⇒ 回调不跑 ⇒ 桌面端行为与今天一字不差。
  ctx.inject(['webServer', 'connection'], (appCtx) => {
    register(appCtx);
  });

  log('宿主半已加载（pending 端点等 webServer/connection 就位后注册）');

  function register(appCtx) {
  const webServer = appCtx.webServer;
  const connection = appCtx.connection;

  // `inject` 已保证两者存在；这里仍留一道 —— 因为**桌面端也可能有 connection
  // 但没有 admit**：属主 README 说 `admit`/认证属于 **Web 载体**那一半，
  // 「Host half 始终提供」的是 RPC 注册表与路由注册表，不含浏览器认证。
  if (!webServer || typeof webServer.register !== 'function') {
    log('✗ ctx.webServer 不可用 → 不注册路由（fail-closed）');
    return;
  }
  if (!connection || typeof connection.admit !== 'function') {
    log('✗ ctx.connection.admit 不可用 → 不注册路由');
    log('  理由：webserver 层没有任何认证，admit 是唯一的闸门。');
    log('  宁可不开这个端点，也不开一个无认证的端点。');
    return;
  }

  // ---- ① pending 表：从会话事件流增量维护 ----
  //
  // 为什么不用 `ctx.sessionProjections`（`practices.md:26` 推荐的那个）：
  //   那条建议针对的是「订阅 session/event **并重扫 session.events**」。我们是
  //   O(1) 的增删，不重扫。且投影是**按会话**的，而我们要的是**跨会话的一张总表**
  //   （用户可能同时开着好几个会话，手机上得都收得到）。
  //
  // 事件形状（属主源码 `dsh-user-approval\lib\index.js:132-142` + 真实日志核过）：
  //   approval/asked   → data = { id, toolName, callId?, reason? }   ⚠️ 后两个可选
  //   approval/decided → data = { id, outcome }
  const pending = new Map(); // id -> { id, toolName, callId, reason, command, target, at }
  const waiters = new Set(); // () => void，长轮询挂在这上面

  // ---- T10：`progress`（「AI 这次干到哪了」）----
  //
  // 只维护**一份**，记「最近活跃的那个会话」。手机没打开时用户要回答的问题是
  // 「AI 在干嘛」，对"最近动过的那个"就够了；多会话并列是少数情况。
  // ⚠️ 这是**有意的简化**，写下来是免得下次把它当成 bug：真要多会话并列就是再加一层按 sessionId 分组。
  //
  // 只送**原料**（与 pending 同一条纪律，见文件头）：
  //   `toolName` 是 wire 名（`write` / `pwsh` / …），翻成「正在改文件」是 **App 的事** ——
  //   App 的 `ApprovalText` 已经有那张映射表，复用即可。在这里再写一套 = 同一个东西翻两遍。
  //   ⚠️ `sinceTs` 用 `Date.now()`，**与响应里的 `now` 同一个钟**。
  //      手机和 PC 的钟不一定同步 ⇒ **App 必须用「服务端 now − sinceTs」算已跑时长**，
  //      拿手机自己的钟去减会得到一个荒谬的数（这个坑在 P3/P4 落地时必踩，先写在这）。
  let progress = null; // { sessionId, turn, step, toolName, target, command, sinceTs }

  // progress 的唤醒必须**节流**：`tool/call` 会连着来（一次读 20 个文件就是 20 条），
  // 每个都唤醒 ⇒ 手机连着收 20 个长轮询回包 ⇒ 忙等换了个形态又回来了。
  // 3 秒内的多次变化合并成一次；实在没唤醒也有 wait 超时兜底（最长滞后一个轮询周期）。
  const PROGRESS_WAKE_MIN_MS = 3000;
  let lastProgressWakeAt = 0;
  const wakeForProgress = () => {
    const t = Date.now();
    if (t - lastProgressWakeAt < PROGRESS_WAKE_MIN_MS) return;
    lastProgressWakeAt = t;
    wakeAll();
  };

  // callId -> { name, argsText }，只为了给审批补 `command` / `target` 那两格原料。
  // ⚠️ 有界：`tool/call` 是**每次工具调用**都来一条，长会话下不裁会一路涨。
  //    （客户端半 `client.js` 的 callCollector 是同一套做法，那边裁到 200。）
  const calls = new Map();
  const CALL_KEEP = 200;

  // T9-h：sessionId -> 会话标题（通知上「是谁在请求」那一行的人话名字）。
  // ⚠️ 有界：长跑下会话数会一路涨，跟 `calls` 一样得裁。
  //    裁掉的代价只是「很老的会话标题没了」—— 那种会话本来也不会有新审批。
  const titles = new Map();
  const TITLE_KEEP = 50;

  // 摘要字段的长度上限。**纯卫生**：`run_code` 这类工具的参数可能是一整段代码，
  // 不夹住会整段塞进通知。取不到这两个键的工具自然就是 null，不走这里。
  const SUMMARY_MAX = 400;

  const clip = (s) =>
    typeof s === 'string' && s.length > 0
      ? s.length > SUMMARY_MAX
        ? s.slice(0, SUMMARY_MAX) + '…'
        : s
      : null;

  const parseArgs = (argsText) => {
    if (typeof argsText !== 'string' || argsText === '') return null;
    try {
      const v = JSON.parse(argsText); // `arguments` 是 JSON **字符串**，要二次 parse
      return isObj(v) ? v : null;
    } catch {
      return null; // 不是合法 JSON 就算了 —— 摘要是**可选**的，不是错误
    }
  };

  // ⚠️ 键名不是猜的：`write` 用 `file_path`，`read` / shell 用 `path`。
  //    只查 `path` 的后果是那行**整行静默消失**（T3g 踩过的真 bug，排查很费劲）。
  //    顺序照抄 dsh 自己那份 `FILE_PATH_KEYS = ["path","file_path"]`
  //    （`refs\dsh-ui-tool\lib\client.js:235`）。
  // T9-d8：这条审批属于哪个会话。取不到给 null，**不编**（文件头那条「缺字段照常出通知」）。
  const sessionIdOf = (session) => {
    const v = session !== null && typeof session === 'object' ? session.id : undefined;
    return v === undefined || v === null || v === '' ? null : String(v);
  };

  const pickTarget = (args) => {
    if (args === null) return null;
    for (const k of ['path', 'file_path']) {
      if (typeof args[k] === 'string' && args[k] !== '') return args[k];
    }
    return null;
  };

  /** 从 `tool/call` 的原料里取那两个摘要字段；取不到给 null。 */
  const summarize = (callId) => {
    const call = typeof callId === 'string' ? calls.get(callId) : undefined;
    if (!call) return { command: null, target: null, sandboxPermissions: null };
    const args = parseArgs(call.argsText);
    return {
      command: clip(args !== null && typeof args.command === 'string' ? args.command : null),
      target: clip(pickTarget(args)),
      // T9-h：提权审批的指纹。**刻意不 clip** —— 它是 `danger-full-access` 这种短枚举，
      //        不是自由文本；真被塞了长串也没关系，App 那边只判「有没有」。
      sandboxPermissions:
        args !== null &&
        typeof args.sandbox_permissions === 'string' &&
        args.sandbox_permissions !== ''
          ? args.sandbox_permissions
          : null,
    };
  };

  const wakeAll = () => {
    // 取快照再遍历：waiter 在 finish 里会把自己从集合里摘掉
    for (const w of [...waiters]) {
      try {
        w();
      } catch (e) {
        log('!! 唤醒 waiter 出错: ' + errText(e));
      }
    }
  };

  const onSessionEvent = (session, event) => {
    // 监听器里必须吞异常：不吞的话「少一条待批记录」会升级成**整个事件流炸掉**。
    try {
      const type = event?.type;
      const data = event?.data;
      if (data === null || typeof data !== 'object') return;

      if (type === 'tool/call') {
        // 只收原料，不出节点、不进 pending 表。形状：{ turn, step, callId, name, arguments }
        const callId = typeof data.callId === 'string' ? data.callId : null;
        if (callId === null) return;

        calls.set(callId, {
          name: typeof data.name === 'string' ? data.name : null,
          argsText: typeof data.arguments === 'string' ? data.arguments : null,
        });
        // Map 按插入序迭代 ⇒ 删最早的
        while (calls.size > CALL_KEEP) calls.delete(calls.keys().next().value);

        // ⚠️ 竞态兜底：`tool/call` 理论上排在 `approval/asked` 前面，但**不是保证**。
        //    真晚到的话，那条审批的 command/target 会永远空着 ⇒ 这里回头补一次。
        //    补上了要 `wakeAll()` —— 手机正在挂着的长轮询会被唤醒、重取快照、
        //    把通知**原地更新**成带摘要的版本（同一个通知 id，只更新不重弹）。
        let enriched = false;
        for (const e of pending.values()) {
          if (e.callId === callId && e.command === null && e.target === null) {
            const s = summarize(callId);
            if (s.command !== null || s.target !== null) {
              e.command = s.command;
              e.target = s.target;
              enriched = true;
            }
          }
        }
        if (enriched) {
          log('~ 已给待批补上摘要');
          wakeAll();
        }

        // T10：进度跟着工具调用走 —— 手机上「正在改文件 · D:\x.txt」就是这条来的。
        // ⚠️ `sinceTs` 记的是**本轮（turn）开始**的时刻，不是这次调用的时刻 ——
        //    通知要回答的是「AI **这次**干多久了」，所以它整轮里保持不变。
        //    同一轮的判据是 `sessionId + turn` 都相同；对不上（没收到 turn/start 就来了 tool/call）就重置。
        const sid = sessionIdOf(session);
        const turn = numOrNull(data.turn);
        const sameTurn =
          progress !== null && progress.sessionId === sid && progress.turn === turn;
        const s = summarize(callId);
        progress = {
          sessionId: sid,
          turn,
          step: numOrNull(data.step),
          toolName: typeof data.name === 'string' ? data.name : null,
          target: s.target,
          command: s.command,
          sinceTs: sameTurn ? progress.sinceTs : Date.now(),
        };
        wakeForProgress();
        return;
      }

      // T10：这一轮的起点。`turn/end` 之前没有工具调用时（模型在思考），
      // 进度就是「本轮已跑 X」，工具那两格是空的。
      if (type === 'turn/start') {
        progress = {
          sessionId: sessionIdOf(session),
          turn: numOrNull(data.turn),
          step: null,
          toolName: null,
          target: null,
          command: null,
          sinceTs: Date.now(),
        };
        wakeForProgress();
        return;
      }

      // T10：步号（只更新、**不唤醒** —— `step/start` 后面紧跟 `tool/call`，
      // 为它单独发一次长轮询回包不划算，那条会带上同样的信息）。
      if (type === 'step/start') {
        if (progress !== null && progress.sessionId === sessionIdOf(session)) {
          progress.step = numOrNull(data.step);
        }
        return;
      }

      // T10：这一轮结束了 ⇒ 没有「正在干的事」了，通知该回到「监听中」。
      // ⚠️ 只清**同一个会话**的：别的会话可能还在跑。
      if (type === 'turn/end') {
        if (progress !== null && progress.sessionId === sessionIdOf(session)) {
          progress = null;
          wakeForProgress();
        }
        return;
      }

      // T9-h：会话标题 —— 通知上「是谁在请求」那一行的原料。
      // ⚠️ 一个会话来**两条**（fallback 半截话 → provider 小模型精修）⇒ 后到无条件覆盖。
      //    空标题不存：免得上屏一行空话（与 `command` / `target` 的「不编」同一条纪律）。
      if (type === 'session/title') {
        const sid = sessionIdOf(session);
        const t = typeof data.title === 'string' ? data.title.trim() : '';
        if (sid !== null && t !== '') {
          titles.delete(sid); // 先删再插 = 挪到 Map 末尾，让裁剪按「最近更新」淘汰
          titles.set(sid, t);
          while (titles.size > TITLE_KEEP) titles.delete(titles.keys().next().value);
          // ⚠️ 只在**有待批**时唤醒：标题是给通知用的，没通知就没必要叫醒 App 白跑一趟。
          if (pending.size > 0) wakeAll();
        }
        return;
      }

      if (type === 'approval/asked') {
        const id = data.id === undefined || data.id === null ? null : String(data.id);
        if (id === null) return;
        const callId = typeof data.callId === 'string' ? data.callId : null;
        const s = summarize(callId);
        pending.set(id, {
          id,
          sessionId: sessionIdOf(session), // T9-d8：点通知直达要用它
          toolName: typeof data.toolName === 'string' ? data.toolName : null,
          callId,
          // `reason` 是模型自己写的自然语言，本来就给用户看的（常已是中文）。
          reason: typeof data.reason === 'string' ? data.reason : null,
          // 摘要字段：**取不到就是 null，不编**（见文件头那条「只送原料」）。
          command: s.command,
          target: s.target,
          sandboxPermissions: s.sandboxPermissions, // T9-h：风险色标的原料
          at: Date.now(),
        });
        log(`+ 待批 ${pending.size} 条（${data.toolName ?? '?'}）`);
        wakeAll();
      } else if (type === 'approval/decided') {
        const id = data.id === undefined || data.id === null ? null : String(data.id);
        if (id === null) return;
        if (pending.delete(id)) log(`- 待批 ${pending.size} 条`);
        // 🔴 这次唤醒是**必要的**，不是防御性代码 —— 它是 App **撤通知的即时通路**：
        //    用户在**电脑上**点了「拒绝 / 允许一次」，手机不该等满一个 wait 周期
        //    才知道。（配合 ② 「非空也挂住」的语义，waiter 可以在表非空时就挂在那儿，
        //    所以这条路径真的会被走到 —— 这与「进 waiter 的前提是表空」那种旧语义不同。）
        wakeAll();
      }
    } catch (e) {
      log('!! session/event 监听器出错: ' + errText(e));
    }
  };

  appCtx.on('session/event', onSessionEvent);

  // ---- ② 路由 ----
  const snapshot = () => {
    // T9-h：标题**现场 join**，不塞进 pending 条目里 —— 它是小模型异步生成的，
    //        可能比审批晚到；塞进去＝把「标题还没生成」那一刻永久钉死在审批上了。
    // ⚠️ map 出来的是**新对象**，所以下面那句「浅拷一份再送」自动满足。
    const list = [...pending.values()]
      .map((p) => ({
        ...p,
        sessionTitle: p.sessionId === null ? null : titles.get(p.sessionId) ?? null,
      }))
      .sort((a, b) => a.at - b.at);
    // T10：`progress` 是**新增字段**，老的 App 不认它、照常只看 `pending` ⇒ 向后兼容。
    // 浅拷一份再送：这份快照会走到 `JSON.stringify`，别把内部对象直接递出去。
    return {
      now: Date.now(),
      pending: list,
      progress: progress === null ? null : { ...progress },
    };
  };

  const sendJson = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };

  const handler = async (req, res) => {
    try {
      // ① 闸门。admit 是同步的、无副作用，返回 { peer } 或 { rejection: 401|403 }。
      const verdict = connection.admit(req);
      if (verdict && verdict.rejection !== undefined) {
        sendJson(res, verdict.rejection, { error: 'unauthorized' });
        return;
      }

      // ② 长轮询：**空表、非空表都挂住等「变化」**；`wait=0` 才是「立刻要快照」。
      //
      // 🔴 为什么不是「有待批就立刻回」—— 这是 2026-10-14 实测踩到的真缺陷：
      //    原来那条短路写在 wait 之前 ⇒ 只要审批一直挂着不点，`?wait=25` 就
      //    **完全不起作用**：连着 6 次请求在 0.4 秒内全部返回（证据见档案）。
      //    照直写 `while (true) poll()` 就是忙等，一秒几十次请求，烧电烧流量。
      //    ⇒ 把节流做进**协议**，客户端就不可能写错：
      //        首轮 `?wait=0` 拿快照 → 之后 `?wait=N` 挂住，**有变化才回**。
      const waitSec = parseWait(req.url, maxWaitSec);
      if (waitSec <= 0) {
        sendJson(res, 200, snapshot());
        return;
      }

      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        waiters.delete(finish);
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          sendJson(res, 200, snapshot());
        } catch (e) {
          log('!! 长轮询回包失败（客户端可能已断）: ' + errText(e));
        }
      };

      waiters.add(finish);
      timer = setTimeout(finish, waitSec * 1000);

      // 客户端断线就把 waiter 摘掉，别挂到超时才回收。
      // ⚠️ 用 res 的 'close' 而不是 req 的 —— 正常回完包也会触发 'close'，
      //    所以要用 `writableEnded` 把「正常结束」和「对端跑了」区分开。
      res.on('close', () => {
        if (settled || res.writableEnded) return;
        settled = true;
        cleanup();
      });
    } catch (e) {
      // 兜底：任何意外都要把响应收掉，绝不能让请求悬着
      log('!! handler 出错: ' + errText(e));
      try {
        if (!res.headersSent) sendJson(res, 400, { error: 'bad request' });
        else res.end();
      } catch {
        /* 连回包都失败了，那就只剩销毁 socket */
        try {
          res.destroy();
        } catch {}
      }
    }
  };

  const disposeRoute = webServer.register({ kind: 'exact', path: routePath, handler });

  // 路由要跟着 fiber 一起释放（属主文档 host-plugin.md：「Register every resource
  // inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup」）。
  if (typeof appCtx.effect === 'function') {
    appCtx.effect(() => () => {
      try {
        disposeRoute();
      } catch {}
    }, 'agentwatch:pending-route');
  }

  log(`已注册 ${routePath}（最长挂 ${maxWaitSec}s）`);
  log(`  闸门 = connection.admit；webserver 层无认证，见文件头注释`);
  } // register()
}

/** 解析 ?wait=<秒>，夹在 [0, max]。坏值当 0（立刻返回，不挂）。 */
function parseWait(url, max) {
  try {
    const raw = new URL(url ?? '/', 'http://x').searchParams.get('wait');
    if (raw === null || raw === '') return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.floor(n), max);
  } catch {
    return 0;
  }
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** T10：轮/步号取不到就是 null，**不编**（与 `command` / `target` 同一条纪律）。 */
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function errText(e) {
  return e instanceof Error ? e.message : String(e);
}

function log(msg) {
  console.log('[agentwatch] ' + msg);
}
