const puppeteer = require('puppeteer-core');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/snap/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  // 收集所有网络请求
  const requests = [];
  const responses = [];
  
  page.on('request', request => {
    const url = request.url();
    if (url.includes('lovart') || url.includes('api') || url.includes('generate') || url.includes('image')) {
      requests.push({
        url: url,
        method: request.method(),
        headers: request.headers(),
        postData: request.postData()
      });
    }
  });

  page.on('response', async response => {
    const url = response.url();
    if (url.includes('lovart') || url.includes('api') || url.includes('generate') || url.includes('image')) {
      try {
        const text = await response.text().catch(() => null);
        responses.push({
          url: url,
          status: response.status(),
          headers: response.headers(),
          body: text ? text.substring(0, 5000) : null
        });
      } catch (e) {}
    }
  });

  console.log('Navigating to https://www.lovart.ai...');
  await page.goto('https://www.lovart.ai', { waitUntil: 'networkidle2', timeout: 60000 });
  
  // 等待页面加载
  await page.waitForTimeout(5000);
  
  // 获取页面内容
  const html = await page.content();
  fs.writeFileSync('/home/ubuntu-m/.openclaw/workspace-lay-a/lovart_page.html', html);
  
  // 获取所有脚本URL
  const scripts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
  });
  
  console.log('Scripts found:', scripts);
  
  // 保存网络请求
  fs.writeFileSync('/home/ubuntu-m/.openclaw/workspace-lay-a/lovart_requests.json', JSON.stringify({ requests, responses }, null, 2));
  
  // 尝试找到生成按钮或功能入口
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, a, [role="button"]')).map(el => ({
      text: el.textContent?.trim(),
      class: el.className,
      id: el.id
    })).filter(b => b.text && b.text.length > 0);
  });
  
  console.log('Buttons found:', buttons.slice(0, 20));
  
  await browser.close();
  console.log('Research complete!');
})();
