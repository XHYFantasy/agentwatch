// 远程AI监看 · 插件本体（T3d 定案后的形态）
//
// ============================================================================
// 🎯 这个插件只做一件事：**在 dsh 原生审批卡内部的那一个格子里，加上原生没有的那句话。**
// ============================================================================
//
// 为什么不建「平行的卡片流」（2026-10-12 两次实测的结论，别再往回走）：
//
//   ① T3a 工具调用卡片 —— 做完发现 dsh 原生就是「每次调用一个 `tool-call` 节点 +
//      中文动词 + 模型写的 description 当摘要 + 成败状态 + read 给可点文件链接」，
//      我们另画一张的结果是 DOM 里 `运行命令×2`：**每个调用被画两遍**。已撤。
//   ② D12 的 step 卡 / 审批卡 —— 基线探针 `cdp-probe --flow` 清点原生节点：
//      `assistant-step`（思考）/ `tool-call` / `turn-process` / `user` **全都有**，
//      我们那两张同样是重复（「🔐 需要你批准」与原生面板同屏各说各的）。已撤。
//   ③ 权威依据（`refs\dsh-ui-tool\README.zh.md`）：
//        > 业务 UI 包只注册 wire 工具名称和原子视图——它们**不配对会话事件、不重建
//        > transcript**，也不拥有 root/subcall 拓扑。
//      —— 「在 dsh 里再搭一套平行结构」这个方向本身就是错的。
//
// 唯一的落点：`conversation.approval.detail`
// ---------------------------------------------------------------------------
//   dsh 的审批卡**不是对话流里的节点**，而是**接管输入区**：`conversation.composer`
//   是 chain 槽位，`@deepseek-ai/dsh-client-ui-approval` 以 priority 1 + `select`
//   匹配待批请求，赢得后渲染 ApprovalPanel（顶条「等待审批」/ 标题 reason /
//   **详情位** / 「拒绝」「允许一次」）。
//
//   `conversation.approval.detail` 是它声明并由它在卡内 `renderSlot` 的子槽位。
//
//   ⚠️⚠️ 它是 **`single` 槽位**，`ui-slots/lib/index.js:171` 明写**同 priority 再注册
//   就直接抛错**（不是顶掉，是**插件加载失败**）。但同一行的报错提示给了正解：
//        「register at a different priority to shadow it (lowest renders)」
//   而 `entriesOfSlot`（`:278`）取每组里**优先级最小**的非弃权条目 →
//   **我们在 priority: -1 注册即可正规遮蔽，不抛错。**（实测已通过，见 logs\t3e.png）
//
//   被遮蔽的是 `ApprovalCommand`（`dsh-client-ui-chat`）：它**只在 `args.command`
//   存在时才画** → 实际**只有 shell 工具有内容**；审批 write / edit 时那格子本来
//   就是空的（实测）。**所以「命令原文照旧显示」这件事，我们只对 shell 工具需要做。**
//
// dsh 自己写下来的那条缝（`refs\dsh-ui-approval\README.zh.md` 原文）：
//   > 请求方提供的本地化展示文案跟随界面语言，不改写审计原因，**也不翻译模型生成的文本**。
// 另有两条原生缺口：只有**一个 warning 色**（无风险分级）、**不说后果**。
// —— 这三条就是本插件存在的理由，也是它全部的野心。
//
// 数据从哪来：**不用 `useChat`、不加 inject**。`tool/call` 事件里就有
// `{ callId, name, arguments }`（`arguments` 是 **JSON 字符串**，要二次 parse）。

window.__ModuleLoader__.load({
  id: '@local/agentwatch-card',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ========================================================================
    // T3f 静默收集器：只收数据，**不画任何节点**（buildViewNode 恒返回 null）
    // ========================================================================
    // 用一个永远不出节点的 Definition 来读事件流 —— 这是 D12 已经验通的路子。
    // 因为不出节点，所以**不可能造成重复**（T3a 的教训在这里是结构性免疫的）。
    const calls = new Map(); // callId -> { name, args }
    const watchers = new Set();

    function useCall(callId) {
      const [rec, setRec] = React.useState(() =>
        typeof callId === 'string' ? calls.get(callId) : undefined
      );
      React.useEffect(() => {
        if (typeof callId !== 'string') return undefined;
        const sync = () => setRec(calls.get(callId));
        sync();
        watchers.add(sync);
        return () => {
          watchers.delete(sync);
        };
      }, [callId]);
      return rec;
    }

    const callCollector = {
      kind: 'agentwatch-collect-call',
      target: 'chat',
      match: (event) => {
        if (event.type !== 'tool/call') return null;
        const callId = event.data?.callId;
        return typeof callId === 'string' && callId !== '' ? { id: callId, role: 'start' } : null;
      },
      start: (_context, match) => {
        const d = match.event.data;
        let args = null;
        try {
          args = JSON.parse(d.arguments ?? '');
        } catch {
          args = null; // 解不开就只当没有参数，绝不抛
        }
        calls.set(d.callId, { name: d.name, args });
        // 长会话不涨内存：Map 保插入序，超了就从最老的开始丢
        while (calls.size > 200) calls.delete(calls.keys().next().value);
        for (const fn of watchers) fn();
        return { callId: d.callId };
      },
      update: (context) => context.state,
      // ⭐ 关键：返回 `null` = **不出任何视图节点**。
      //    源码里 `inboxDefinition` 用的是 `publication: () => 'none'`，我照抄过一次，
      //    结果是**插件整个激活失败**（`web boot: 1 entry did not activate`）。
      //    → 回到 D12 实跑验过的这个写法，别再用推演的 API。
      buildViewNode: () => null,
    };

    // ========================================================================
    // 风险判定（v1 走规则，写在界面上标明是规则判定，不装成 AI 判断）
    // ========================================================================
    // 刻意保守：只认「能说清为什么」的几条；说不清的一律归到低风险，
    // 宁可少标，也不要出现「胡乱报警」——那会直接毁掉风险标本身的信任度。
    const DANGEROUS = /(^|\s)(rm|del|rmdir|format|shutdown|diskpart)\b|Remove-Item|Stop-Computer|Restart-Computer|-Recurse\b|--force\b|-rf\b/i;

    // 🔴 路径键必须**按 dsh 自己的顺序都试一遍**：`dsh-ui-tool/lib/client.js:235` 写的是
    //    `FILE_PATH_KEYS = ["path", "file_path"]`。我一开始只查了 `path`，
    //    结果 write 审批里「目标：…」整行不显示 —— **参数明明收到了，只是键名没对上**。
    //    这种「看着没错、实际丢信息」的 bug，不真跑一次是发现不了的。
    const PATH_KEYS = ['path', 'file_path'];
    function pickPath(args) {
      if (args === null || typeof args !== 'object') return null;
      for (const key of PATH_KEYS) {
        if (typeof args[key] === 'string' && args[key] !== '') return args[key];
      }
      return null;
    }

    // wire 工具名以 dsh 自己的分类表为准（`dsh-ui-tool/lib/client.js:83` 的 TOOL_VARIANTS）
    const SHELL = new Set(['bash', 'pwsh']);
    const CODE = new Set(['run_code']);

    function assess(toolName, args) {
      const a = args ?? {};
      if (typeof a.sandbox_permissions === 'string' && a.sandbox_permissions !== '') {
        return { tone: 'danger', label: '需要放宽沙箱', why: `要提到 ${a.sandbox_permissions}` };
      }
      if (typeof a.code === 'string' && DANGEROUS.test(a.code)) {
        return { tone: 'danger', label: '代码里有危险写法', why: '含删除 / 格式化 / 关机一类操作' };
      }
      if (typeof a.command === 'string' && DANGEROUS.test(a.command)) {
        return { tone: 'danger', label: '命令里有危险写法', why: '含删除 / 格式化 / 关机一类操作' };
      }
      if (toolName === 'write' || toolName === 'edit') {
        return { tone: 'warn', label: '会写磁盘', why: '这一步会真的改到文件' };
      }
      if (SHELL.has(toolName)) {
        return { tone: 'warn', label: '会执行命令', why: '会在你机器上跑一条命令' };
      }
      if (CODE.has(toolName)) {
        return { tone: 'warn', label: '会执行代码', why: '会在你机器上跑一段代码' };
      }
      return { tone: 'calm', label: '常规操作', why: '' };
    }

    const TONE = {
      danger: { emoji: '\u{1F534}', color: 'var(--dsw-alias-state-error-primary, #d33)' },
      warn: { emoji: '\u{1F7E1}', color: 'var(--dsw-alias-state-warn-primary, #c80)' },
      calm: { emoji: '\u{1F7E2}', color: 'var(--dsw-alias-state-success-primary, #383)' },
    };

    // ========================================================================
    // 审批详情位组件 —— 本插件的全部产出
    // ========================================================================
    // ⚠️ 它渲染在 `.j_8BDW_command` 里面：那个父元素是**等宽 + 三级灰 + 13px**。
    //    所以 root 上要把 font-family / color / font-size 全部显式拿回来，
    //    否则我们的字会变成一串等宽灰字。实测的 DOM 结构见 logs\t3e.png。
    //
    // 容错底线：**拿不到 callId / 收不到 tool/call 时也必须出内容** ——
    //   后果那两行一条数据都不用，任何情况下都画得出来。
    function ApprovalDetail({ callId }) {
      const call = useCall(callId);
      const args = call?.args ?? null;
      const risk = assess(call?.name, args);
      const tone = TONE[risk.tone] ?? TONE.calm;

      const command = typeof args?.command === 'string' ? args.command : null;
      const target = command === null ? pickPath(args) : null; // 有命令就显示命令，别两行都堆
      const note = typeof args?.description === 'string' ? args.description : null;

      const head = {
        display: 'flex',
        alignItems: 'baseline',
        gap: '6px',
        fontSize: '13px',
        fontWeight: '600',
        color: tone.color,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      };
      const body = {
        fontSize: '12px',
        lineHeight: '1.6',
        color: 'var(--dsw-alias-label-secondary, #555)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        whiteSpace: 'normal',
        wordBreak: 'break-word',
      };
      const mono = {
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-tertiary, #888)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '5px', padding: '2px 0' } },

        // ① 风险 —— 原生只有一个 warning 色，没有分级
        h(
          'div',
          { style: head },
          h('span', null, tone.emoji),
          h('span', null, risk.label),
          risk.why ? h('span', { style: { fontWeight: '400', color: 'var(--dsw-alias-label-tertiary, #888)' } }, `· ${risk.why}`) : null
        ),

        // ② 要动的对象 —— 对 write/edit，**原生这里是空的**，所以我们显示路径就是净增信息
        command ? h('div', { style: mono }, `$ ${command}`) : null,
        target ? h('div', { style: mono }, `目标：${target}`) : null,
        note ? h('div', { style: { ...body, fontStyle: 'italic' } }, `它自己的说法：${note}`) : null,

        // ③ 后果 —— 原生只写「拒绝 / 允许一次」两个词，从不解释各自会发生什么
        //    ⚠️ 这里只能用 React 元素做粗体，不能写 markdown 的 `**`（会原样显示出来）
        h(
          'div',
          { style: body },
          h(
            'div',
            null,
            '允许一次 → 这一步会',
            h('strong', { style: { color: 'var(--dsw-alias-label-primary, #222)' } }, '真的执行'),
            '；只对这一次有效，下次还会再问你。'
          ),
          h('div', null, '拒绝 → agent 会收到「被拒绝」，它可能换个办法再试，也可能就此停下。')
        )
      );
    }

    // ========================================================================
    // T9-d8 ②：给 App 一个「跳到指定会话」的把手
    // ========================================================================
    // 要修的是 T9-d 验收 ③：**审批提醒没错、卡也在、切过去就能批，但点开开错了门** ——
    // 手机点通知进来时 WebView 停在「上次浏览的那个会话」。宿主侧半已经把
    // `sessionId` 送出来了（T9-d8 ①），App 侧缺的是**从外面按那个按钮**的办法。
    //
    // ⭐ 属主自己的写法（源码实证，不是推断）：
    //   · 服务名 `uiWorkspace` —— `refs\dsh-ui-workspace\lib\client.js:772` 的 `super(ctx, "uiWorkspace")`；
    //     方法 `openSession(target)` 收「**已知 Session id**」（`refs\dsh-ui-workspace\README.zh.md:72` 原文）。
    //   · **实例调用长什么样**：`refs\dsh-pkgs\dsh-client-ui-chat\lib\client.js:12466`
    //     —— `ctx.uiWorkspace.openSession(childId);`
    //   · **可选取法长什么样**：`refs\dsh-pkgs\dsh-client-ui-conversation\lib\client.js:17948`
    //     —— `const workspaceNavigation = ctx.get("uiWorkspace");`
    //
    // 🔴 为什么用 `ctx.get` 而**不写进 `inject`**：代价不对等。
    //   ui-chat 把 `"uiWorkspace"` 写进 inject（`:12261`），是因为它离了宿主就没意义；
    //   我们不是 —— 缺这个服务只是「通知点开不能直达」（＝退回今天的行为），
    //   写进 inject 则**它一不在，整张审批卡的白话就全停用**。那是产品本体，不能拿它冒险。
    //   属主自己的文档也是这个口径：`refs\dsh-pkgs\dsh-session-projection\README.zh.md:65`
    //   「载体使用 `ctx.get('sessionProjections')`，**注册表缺席时省略自己的块**」。
    //
    // ⚠️ 返回**字符串**不是布尔：App 侧用 `evaluateJavascript` 取值，
    //   只有拿到 `'opened'` 才算成功，其余值它自己决定重试还是放弃（③ 那台状态机要用）。
    // 🚫 这个钩子**不画任何节点、不碰 React** —— 它不产生界面，只是把 openSession 露出来。
    function installOpenSessionHook(ctx) {
      const open = (id) => {
        if (typeof id !== 'string' || id === '') return 'bad-id';
        try {
          // 每次现取，不缓存：晚注册、被换掉、被销毁都能跟上
          const ws = ctx.get('uiWorkspace');
          if (ws === null || ws === undefined || typeof ws.openSession !== 'function') return 'no-service';
          ws.openSession(id);
          return 'opened';
        } catch {
          // 客户端不认这个 id 之类 —— **不抛**，把判断权交给 App
          return 'error';
        }
      };
      window.__agentwatchOpenSession = open;
      return () => {
        // 只在还是我们那一个时才删，别把后来者的覆盖掉
        if (window.__agentwatchOpenSession === open) delete window.__agentwatchOpenSession;
      };
    }

    return {
      inject: ['slots', 'uiConversation'],
      apply(ctx) {
        // ① 静默收 `tool/call`（不出节点）
        //    ⚠️ **不要包 try/catch**：吞掉异常会把「插件激活失败」变成「静默失效」，
        //    后者难查十倍。让它抛，界面会直接显示 "Failed to load plugins"，一眼可见。
        ctx.uiConversation.events.register(callCollector);

        // ② 占住审批卡内部的详情位。
        //    priority: -1 —— 比 ApprovalCommand 的 0 更小，**这才是官方说的 shadow**。
        //    同 priority 会直接抛错、插件整个加载失败（ui-slots/lib/index.js:171）。
        ctx.slots.inject('conversation.approval.detail', () =>
          ctx.slots.register({ name: 'conversation.approval.detail', priority: -1 }, ApprovalDetail)
        );

        // ③ T9-d8 ②「跳到指定会话」的把手。
        //    🔴 这是全文件**唯一**一处该吞异常的地方，理由和上面两条正好相反：
        //       ①② 是产品本体（失败必须闹出来），③ 是**可选增强** ——
        //       钩子挂不上只是「点通知不能直达」，绝不该连累审批卡。
        //       所以这里单独兜一层，并且**要留痕**（console.error 会被 cdp-probe 的控制台捕获）。
        try {
          if (typeof ctx.effect === 'function') ctx.effect(() => installOpenSessionHook(ctx));
          else installOpenSessionHook(ctx);
        } catch (err) {
          console.error('[agentwatch] 会话直达钩子没装上（不影响审批卡）：', err);
        }
      },
    };
  },
});
