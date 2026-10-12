import { startServer } from '../src/server.mjs';
const port=Number(process.env.TOGETHER_PORT??4380);
const app=await startServer({port});await app.coordinator.loadDemo();
console.log(`一起来麦已启动：${app.url}\n当前为虚构演示。成员 MCP Token 仅配置在各成员自己的 Agent 中。`);
