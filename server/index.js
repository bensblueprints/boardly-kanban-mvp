const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 5315;

createApp().then((app) => {
  app.listen(PORT, async () => {
    console.log('Boardly running');
    console.log(`  Open: http://localhost:${PORT}/`);
    const mcp = await app.startMcpIfEnabled();
    if (mcp) console.log(`  MCP:  ${mcp.url}`);
    if (app.startMailScheduler()) console.log('  Mail: reminders + digest enabled');
  });
}).catch((err) => {
  console.error('Boardly failed to start:', err);
  process.exit(1);
});
