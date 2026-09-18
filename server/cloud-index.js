const { createCloudApp } = require('./cloud');

const app = createCloudApp();
const port = Number(process.env.PORT || 5315);
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`Boardly cloud listening on port ${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => { app.closeWorkspaces(); process.exit(0); }));
}
