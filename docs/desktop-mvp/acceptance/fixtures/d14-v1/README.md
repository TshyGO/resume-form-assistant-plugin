# d14-v1 合成数据

`dataset.json` 和 `expected-results.json` 由同目录的 `generate.mjs` 生成。它们使用固定基准时间、固定逻辑 ID、固定 UUID 和稳定键顺序，因此相同源码应产生完全相同的 UTF-8 字节。

生成与检查：

```powershell
node docs/desktop-mvp/acceptance/fixtures/d14-v1/generate.mjs
node docs/desktop-mvp/acceptance/fixtures/d14-v1/generate.mjs --check
```

夹具中的 `D14_SYNTHETIC_*` 都是用于泄漏检测的无效标记；`.test` 是保留域名。通知和附件只含文本，不包含宏、脚本或可执行载荷。

`dataset.json` 提供输入；`expected-results.json` 提供跨模块应保持的业务断言。运行时生成的真实 UUID 应映射到 `application-a` 等逻辑 ID，不要求与夹具固定 UUID 相同。case 可以各自在隔离档案上执行，不能假定另一个 case 已先运行。
