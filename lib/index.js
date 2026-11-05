/**
 * DSH 插件入口 —— 把「实验室网关本地反代」挂进 DeepSeek Harness 进程。
 *
 * 设计原则：尽量不碰 DSH 内部 API。
 *   - 只依赖 ctx.effect() 做生命周期管理（这是 DSH 插件最基础、最稳定的能力）；
 *   - 不 import 任何 @deepseek-ai/* 包，DSH 升级/换版本时不会因为内部接口变动而崩；
 *   - 真正的逻辑全在 proxy.mjs，只用 Node 内置模块，也能脱离 DSH 单独跑。
 *
 * 效果：DSH 启动 → 本地 127.0.0.1:8801 可用 → 工具里固定填这个地址，
 *       网关换了 IP 由代理自己发现，DSH 侧的配置永远不用改。
 */
import { createProxyServer, readConfig } from './proxy.mjs';

export const name = 'labai-gateway';
export const inject = [];

/** DSH 传进来的 config 可能是 schemastery 的响应式对象，取快照再合并。 */
function plainConfig(config) {
  if (!config || typeof config !== 'object') return {};
  const raw = typeof config.get === 'function' ? config.get() : config;
  if (!raw || typeof raw !== 'object') return {};
  const allowed = [
    'listenPort', 'gatewayPort', 'labId', 'seedIps', 'scanNets',
    'probeTimeoutMs', 'concurrency', 'cacheTtlSec', 'apiKey', 'overrideAuth',
  ];
  const out = {};
  for (const key of allowed) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

export function apply(ctx, config = {}) {
  const cfg = readConfig(plainConfig(config));

  ctx.effect(() => {
    const { server, finder } = createProxyServer(cfg);

    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        // 多开了一个 DSH 实例，或有人手动起了独立代理：复用那个即可，不要报错刷屏
        console.warn(`[labai] 端口 ${cfg.listenPort} 已被占用，假定已有代理在运行`);
      } else {
        console.error(`[labai] 本地代理启动失败: ${err && err.message}`);
      }
    });

    server.listen(cfg.listenPort, '127.0.0.1');

    // 预热：DSH 一起来就找网关，别让第一次提问卡在网段扫描上
    finder.current().catch(() => {
      // 找不到也不影响启动，等真正发请求时会再试
    });

    return () => {
      try {
        server.close();
      } catch {
        // 进程退出时忽略
      }
    };
  });

  return {
    /** 供其它插件/调试用：拿到当前的 finder，可主动 invalidate()。 */
    status: () => ({ listenPort: cfg.listenPort, labId: cfg.labId }),
  };
}

export default { name, inject, apply };
