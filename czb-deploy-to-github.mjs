#!/usr/bin/env node
// czb-deploy-to-github.mjs —— 无需本地 git，一键把项目推送到 GitHub 并启用 Pages
// 用法：GITHUB_TOKEN=ghp_xxx node czb-deploy-to-github.mjs [repo-name]
import fs from 'fs';
import path from 'path';

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('请先设置环境变量 GITHUB_TOKEN。');
  console.error('获取方式：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)');
  console.error('所需权限：repo、workflow、admin:repo_hook（可选）');
  process.exit(1);
}

const REPO_NAME = process.argv[2] || 'czb-a-stock-workbench';
const REPO_DESC = '操作比名拽 A股交易工作台 - 每日晨报/复盘/持仓管理';
const API = 'https://api.github.com';
const ROOT = process.cwd();

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '.workbuddy', 'dist', 'deploy-dist']);
// 仅上传核心文件，避免把临时脚本、旧版本、本地数据污染到公开仓库
const ALLOW_LIST = new Set([
  '操作比名拽-A股工作台.html',
  'daily-data.json',
  'czb-sources.json',
  'czb-fetch-sources.mjs',
  'czb-morning-build.mjs',
  'czb-review-build.mjs',
  'czb-deploy-to-github.mjs',
  '操作比名拽-README.md',
  '.gitignore',
]);

async function gh(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new Error(`GitHub API ${opts.method || 'GET'} ${path} → ${res.status}: ${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

function shouldInclude(filePath) {
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const parts = rel.split('/');
  if (parts.some(p => EXCLUDE_DIRS.has(p))) return false;
  if (parts[0] === '.github') return true;   // 工作流必须上传
  return ALLOW_LIST.has(rel);
}

function collectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldInclude(full)) out.push(...collectFiles(full));
    } else {
      if (shouldInclude(full)) out.push(full);
    }
  }
  return out;
}

async function main() {
  console.log('1) 获取 GitHub 用户信息...');
  const user = await gh('/user');
  const owner = user.login;
  console.log(`   用户：${owner}`);

  console.log(`2) 创建仓库 ${REPO_NAME}...`);
  let repo;
  try {
    repo = await gh('/user/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: REPO_NAME,
        description: REPO_DESC,
        private: false,
        has_issues: true,
        has_wiki: false,
      }),
    });
    console.log('   仓库已创建');
  } catch (e) {
    if (e.message.includes('422') || e.message.includes('already exists')) {
      console.log('   仓库已存在，使用现有仓库');
      repo = await gh(`/repos/${owner}/${REPO_NAME}`);
    } else {
      throw e;
    }
  }

  console.log('3) 收集本地文件...');
  const files = collectFiles(ROOT);
  console.log(`   共 ${files.length} 个文件`);

  console.log('4) 上传文件（自动创建首次 commit，兼容空仓库）...');
  for (const full of files) {
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    const content = fs.readFileSync(full, 'utf8');
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    try {
      await gh(`/repos/${owner}/${REPO_NAME}/contents/${rel}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Add ${rel}`, content: b64 }),
      });
      console.log(`   已上传 ${rel}`);
    } catch (e) {
      // 若文件已存在，需要先取 sha 再更新
      if (e.message.includes('422') || e.message.includes('sha')) {
        try {
          const cur = await gh(`/repos/${owner}/${REPO_NAME}/contents/${rel}`);
          await gh(`/repos/${owner}/${REPO_NAME}/contents/${rel}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Update ${rel}`, content: b64, sha: cur.sha }),
          });
          console.log(`   已更新 ${rel}`);
        } catch (e2) {
          console.warn(`   上传失败 ${rel}: ${e2.message}`);
        }
      } else {
        console.warn(`   上传失败 ${rel}: ${e.message}`);
      }
    }
  }
  console.log('   已推送到 main 分支');

  console.log('5) 启用 GitHub Pages...');
  try {
    await gh(`/repos/${owner}/${REPO_NAME}/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { branch: 'gh-pages', path: '/' } }),
    });
    console.log('   Pages 已启用（source: gh-pages）');
  } catch (e) {
    if (e.message.includes('409') || e.message.includes('already enabled')) {
      console.log('   Pages 已启用，跳过');
    } else {
      console.warn('   启用 Pages 失败，请手动到仓库 Settings → Pages 开启：', e.message);
    }
  }

  const pagesUrl = `https://${owner}.github.io/${REPO_NAME}/`;
  const repoUrl = repo.html_url;

  console.log('\n✅ 部署完成！');
  console.log(`仓库地址：${repoUrl}`);
  console.log(`访问地址：${pagesUrl}`);
  console.log('\n下一步：');
  console.log('1. 打开仓库 → Settings → Pages → Build and deployment → Source，选择「Deploy from a branch」→ 分支选「gh-pages」→ 文件夹「/ (root)」。');
  console.log('2. 首次 Pages 部署由 GitHub Actions 在第一次定时任务或手动触发 workflow 后完成。');
  console.log('3. 也可立即到 Actions 标签页，手动运行「操作比名拽 - 每日晨报与复盘」workflow 生成第一份 gh-pages 数据。');
}

main().catch(err => {
  console.error('\n❌ 部署失败：', err.message);
  process.exit(1);
});
