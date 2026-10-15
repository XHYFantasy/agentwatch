// T2 烟雾测试：验证自定义 slot 能否在 Harness Web UI 里渲染，且客户端 JS 是活的。
// 有意做成"点一下会变"——静态卡片无法区分"渲染成功"和"渲染了一张图"。
window.__ModuleLoader__.load({
  id: '@local/agentwatch-smoke',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    function SmokeCard() {
      const [clicked, setClicked] = React.useState(false);
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 10px',
            margin: '6px 0',
            border: '1px solid var(--dsw-alias-border-base, #d0d0d5)',
            borderRadius: '8px',
            font: '12px/1.4 system-ui, -apple-system, sans-serif',
          },
        },
        h('span', null, '\u{1F440}'),
        h('span', null, '远程监看 bridge · 插件链路已通'),
        h(
          'button',
          {
            type: 'button',
            onClick: () => setClicked(true),
            style: {
              marginLeft: 'auto',
              font: 'inherit',
              padding: '2px 8px',
              borderRadius: '6px',
              border: '1px solid currentColor',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            },
          },
          clicked ? '客户端 JS 已执行 ✓' : '点我验证'
        )
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'agentwatch-smoke', order: 5 },
            SmokeCard
          )
        );
      },
    };
  },
});
