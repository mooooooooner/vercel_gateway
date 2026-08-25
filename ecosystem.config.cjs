module.exports = {
  apps: [
    {
      name: 'vercel-gateway',
      script: 'src/server.js',
      cwd: '/root/vercel-gateway',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
