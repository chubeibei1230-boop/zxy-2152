const { execSync, spawn } = require('child_process');
const path = require('path');

const PORT = 8112;

function findProcessOnPort(port) {
  try {
    const result = execSync(`netstat -ano | findstr :${port}`).toString();
    const lines = result.split('\n').filter(l => l.trim());
    const pids = [];
    lines.forEach(l => {
      const parts = l.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && !pids.includes(pid)) pids.push(pid);
    });
    return pids;
  } catch (e) {
    return [];
  }
}

function killPids(pids) {
  pids.forEach(pid => {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      console.log(`已终止进程 PID=${pid}`);
    } catch (e) {}
  });
}

console.log(`检查端口 ${PORT} 占用...`);
const pids = findProcessOnPort(PORT);
if (pids.length > 0) {
  console.log(`发现占用端口的进程: ${pids.join(', ')}，正在终止...`);
  killPids(pids);
  const waitUntil = Date.now() + 5000;
  while (Date.now() < waitUntil) {
    const still = findProcessOnPort(PORT);
    if (still.length === 0) break;
    try { execSync('timeout /t 1 /nobreak >nul 2>&1', { stdio: 'ignore' }); } catch (e) {}
  }
}
console.log(`端口 ${PORT} 已清理完毕\n`);

const appPath = path.join(__dirname, 'app.js');
console.log(`启动服务: node ${appPath}`);

const server = spawn('node', [appPath], {
  cwd: __dirname,
  stdio: 'pipe',
  shell: true
});

let serverReady = false;
let startupLog = '';

server.stdout.on('data', (data) => {
  const msg = data.toString();
  startupLog += msg;
  process.stdout.write(msg);
  if (msg.includes('服务已启动') || msg.includes('共享练琴房预约管理系统')) {
    serverReady = true;
  }
});

server.stderr.on('data', (data) => {
  process.stderr.write(data.toString());
});

server.on('close', (code) => {
  console.log(`服务进程退出，代码: ${code}`);
});

const checkAndTest = async () => {
  const startTime = Date.now();
  const timeout = 30000;

  while (!serverReady && Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 500));
  }

  if (!serverReady) {
    console.log('\n服务启动超时，检查输出...');
    console.log(startupLog);
    process.exit(1);
  }

  console.log('\n========= 运行申诉模块 API 测试 =========\n');
  const testPath = path.join(__dirname, 'test-appeals.js');
  const testProcess = spawn('node', [testPath], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: true
  });

  testProcess.on('close', (code) => {
    console.log(`\n申诉模块测试完成，退出代码: ${code}`);
    console.log('\n服务仍在后台运行，可以访问以下地址:');
    console.log(`  http://localhost:${PORT}/api/health`);
    console.log(`  http://localhost:${PORT}/api/info`);
    console.log(`  http://localhost:${PORT}/api/appeals/types`);
    process.exit(code);
  });
};

checkAndTest();
