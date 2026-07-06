const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 5315;
const app = createApp();

app.listen(PORT, () => {
  console.log('Boardly running');
  console.log(`  Open: http://localhost:${PORT}/`);
});
