const puppeteer = require('puppeteer-core');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/snap/bin/chromium',
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });

  const page = await browser.newPage();
  
  // 设置更长的超时
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);
  
  // 设置用户代理
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  // 设置视口
  await page.setViewport({ width: 1920, height: 1080 });
  
  // 收集所有网络请求
  const requests = [];
  const responses = [];
  
  page.on('request', request => {
    const url = request.url();
    requests.push({
      url: url,
      method: request.method(),
      resourceType: request.resourceType(),
      headers: request.headers(),
      postData: request.postData()
    });
  });

  page.on('response', async response => {
    const url = response.url();
    try {
      responses.push({
        url: url,
        status: response.status(),
        headers: response.headers()
      });
    } catch (e) {}
  });

  console.log('Navigating to https://www.lovart.ai...');
  
  try {
    // 使用 domcontentloaded 而不是 networkidle2
    await page.goto('https://www.lovart.ai', { 
      waitUntil: 'domcontentloaded', 
      timeout: 120000 
    });
    
    // 等待一段时间让页面加载
    await page.waitForTimeout(10000);
    
    // 获取页面内容
    const html = await page.content();
    fs.writeFileSync('/home/ubuntu-m/.openclaw/workspace-lay-a/lovart_page.html', html);
    console.log('Page HTML saved');
    
    // 获取所有脚本URL
    const scripts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
    });
    console.log('Scripts found:', scripts.length);
    
    // 保存网络请求
    fs.writeFileSync('/home/ubuntu-m/.openclaw/workspace-lay-a/lovart_requests.json', JSON.stringify({ requests, responses }, null, 2));
    console.log('Requests saved');
    
    // 获取页面文本内容
    const pageText = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync('/home/ubuntu-m/.openclaw/workspace-lay-a/lovart_text.txt', pageText);
    console.log('Page text saved');
    
  } catch (error) {
    console.error('Error:', error.message);
    // 即使出错也保存已收集的数据
    fs.writeFileSync('/home/ubuntu-m/.openclaw/workspace-lay-a/lovart_requests.json', JSON.stringify({ requests, responses }, null, 2));
  }
  
  await browser.close();
  console.log('Research complete!');
})();
