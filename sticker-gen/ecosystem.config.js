module.exports = {
  apps: [
    {
      name: 'sticker-gen',
      script: 'server.js',
      cwd: '/home/ubuntu-m/.openclaw/workspace-lay-a/sticker-gen',
      env: { PORT: 7788 }
    },
    {
      name: 'sticker-dev',
      script: 'server.js',
      cwd: '/home/ubuntu-m/.openclaw/workspace-lay-a/sticker-gen',
      env: { PORT: 7789 }
    }
  ]
};
