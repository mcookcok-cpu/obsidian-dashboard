module.exports = {
  apps: [
    {
      name: 'obsidian-dashboard',
      script: 'server.js',
      cwd: __dirname,
      max_memory_restart: '200M',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'vault-bot',
      script: 'vault-bot.js',
      cwd: __dirname,
      max_memory_restart: '150M',
      env: { NODE_ENV: 'production' }
    }
  ]
};
