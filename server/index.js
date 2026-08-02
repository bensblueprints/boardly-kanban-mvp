const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 5315;
const app = createApp();

app.listen(PORT, async () => {
  console.log('Boardly running');
  console.log(`  Open: http://localhost:${PORT}/`);
  const mcp = await app.startMcpIfEnabled();
  if (mcp) console.log(`  MCP:  ${mcp.url}`);
});
