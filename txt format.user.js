// ==UserScript==
// @name        txt format (DOM优化版)
// @namespace   http://tampermonkey.net/
// @version     2026-08-11.22
// @description 智能格式化txt文件：自动识别章节标题、清理异常字符、保留章节标题空格，支持暗色模式与EPUB导出。版本历史见脚本头部注释。
// @author      yolo
// @match       file://*/*.txt
// @require     https://unpkg.com/fflate@0.8.2/umd/index.js
// @grant       GM_addStyle
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_registerMenuCommand
// ==/UserScript==

/**
 * 版本历史
 * v7.30         自动识别段落内部的章节标题（如“。」第二章”）并正确拆分
 * v7.31         增加暗色模式
 * v7.32         清理私用区等无字形字符，修复段首“方块”问题
 * v7.33         修复标点误删、多章节重复、长标题误拆、引号断句问题，新增原文模式
 * v7.34         章节标题中的空格保留，正文汉字间空格仍清理
 * 2026-08-09.05 版本号统一：PARSER_VERSION 由 @version 自动派生，不再单独维护
 * 2026-08-09.06 启动时自动清理旧版本的渲染缓存，避免 IndexedDB 无限累积
 * 2026-08-09.07 自动统一章节编号风格（阿拉伯/中文混排、前导零），章节识别支持 零/百/千
 * 2026-08-09.08 阿拉伯章节编号自动识别“前导零补齐”风格并按全书位数统一（如 032/232 均为 3 位）
 * 2026-08-09.09 支持“卷名 + 第X回 + 标题”式标题识别（如“龙潜于渊 第一回 临安会”），
 *               标题内空格全部保留；同时收紧“第X章”开头的多重标记正文句误判
 * 2026-08-09.10 侧边栏目录超长标题单行省略显示，悬停可看完整标题，避免目录长短不一
 * 2026-08-09.11 修复“（数字）”式标题误判：括号编号后带句读标点或过长时按正文处理，
 *               避免把“（六）杨门女将……，……”这类长段落误切成标题
 * 2026-08-09.12 支持“（数字）标题”与正文粘连的自动拆分：结合跨行延续词（之际/之时……）
 *               与正文起始词词典（正当/却说/话说……），拆出短标题与正文，如“（六）杨门女将”
 * 2026-08-09.13 修复“（数字）”标题误收手打分隔符：剥离标题首尾的星号/横线等分隔符串
 *               （如“（十）＊＊＊＊＊＊”只取“（十）”），粘连拆分时标题部分同样禁止含分隔符
 * 2026-08-09.14 修复侧边栏被超长标题撑宽：给侧边栏加最大宽度（260px）与 min-width: 0，
 *               防止单行省略的 nowrap 内容把侧边栏拉伸到正文宽度
 * 2026-08-09.15 重做暗色模式配色：暖色低眩光纸面、柔和正文色；当前章节改为暖色高亮条
 *               + 浅色文字，修复白字浅底看不清的问题
 * 2026-08-09.16 拆分段落内残留的空隙（连续 2 个及以上空格/全角空格），
 *               把被并进同一行的对话回合恢复为独立段落，如“……？」　　「……”
 * 2026-08-11.17 拆分无空隙直接粘连的对话回合（如“……”“……”），
 *               多人对话按回合独立成段，避免全部挤在一段里影响阅读
 * 2026-08-11.18 作者/书名等书籍信息行（如“作者：快乐鸟”）独立成段，
 *               段落拼接阶段不再把它粘进相邻正文，渲染时按书籍信息处理
 * 2026-08-11.19 修复正文中的“?!”被误当句末标点、从词中间断段的问题
 *               （如乱码“感??受到”/“感？？受到”被拆成“我感?”+“?受到”两段）；
 *               连续 ?! 串夹在汉字间时不再断段；半角 ?! 单独出现时
 *               只在两侧均非汉字（如英文句）时才作为句子结束符
 * 2026-08-11.20 补充修复：源文件在“?!”中间本身就分段/空行时
 *               （如“我感?”与“?受到”两行），段落拼接遇到空行会强制分段；
 *               智能模式下现在会把以 ?! 开头、且上一段没写完的残段并回上一段，
 *               恢复被拆开的完整单词
 * 2026-08-11.21 覆盖替换字符 U+FFFD（编码损坏时的 �/?）：残段合并规则同样
 *               适用于以 U+FFFD 开头/结尾的段落，并在智能模式下把 U+FFFD
 *               从正文中清除，让“感�?受到”这类词直接修复为“感受到”
 * 2026-08-11.22 修复悬空左引号（只有“没有”）导致整段无法按句分段、
 *               渲染成“铁板一块”的问题；对“说：“”“想着：“”等引语动词
 *               引出的对话和整段引语保持原有的不拆句行为，避免引入新问题
 */

(function () {
    'use strict';

    // 版本号唯一来源：@version（即油猴的 GM_info.script.version）。
    // 以后发新版只需改头部 @version，渲染缓存会自动失效，不再需要手动同步。
    // 兜底值仅用于非油猴环境（GM_info 不可用），正常使用时不会走到。
    const PARSER_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version)
        ? GM_info.script.version
        : 'dev';

    const STYLE = `
      :root {
          --main-accent-color: #5d4037;
          --highlight-color: #b71c1c;
          --accent-bg: #b71c1c;
          --paper-bg: #f3eacb;
          --outer-bg: #e3d9be;
          --text-color: #3e2723;
          --sidebar-bg: #f9f3df;
      }
      body.dark-mode {
          --paper-bg: #221e18;
          --outer-bg: #161310;
          --text-color: #d8d2c4;
          --sidebar-bg: #1b1814;
          --main-accent-color: #c9b79a;
          --highlight-color: #e0a37a;
          --accent-bg: #a94f2e;
      }
      body { margin: 0; background-color: var(--outer-bg); font-family: "Source Han Serif SC","PingFang SC", "Microsoft YaHei", sans-serif; color: var(--text-color); overflow: hidden; }
      #reader-app { display: flex; height: 100vh; width: 100vw; overflow: hidden; }
      .sidebar { flex: 0 0 260px; min-width: 0; max-width: 260px; height: 100%; display: flex; flex-direction: column; background: var(--sidebar-bg); border-right: 1px dashed rgba(93, 64, 55, 0.2); z-index: 100; box-sizing: border-box; overflow: hidden; }
      .sidebar-header { padding: 20px 20px 10px 20px; border-bottom: 1px solid rgba(93, 64, 55, 0.1); }
      .export-btn { display: flex; align-items: center; justify-content: center; width: 100%; padding: 10px; background-color: var(--accent-bg); color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: bold; transition: background 0.3s, transform 0.1s; box-shadow: 0 2px 6px rgba(183, 28, 28, 0.2); }
      .export-btn:hover { background-color: #9a1616; transform: translateY(-1px); }
      .export-btn:active { transform: translateY(1px); }
      .export-btn:disabled { background-color: #ccc; cursor: not-allowed; box-shadow: none; transform: none; }

      .sidebar-content { flex: 1; overflow-y: auto; padding: 15px 20px 30px 20px; scrollbar-width: thin; scrollbar-color: rgba(93, 64, 55, 0.3) transparent; }
      .sidebar-content::-webkit-scrollbar { width: 6px; }
      .sidebar-content::-webkit-scrollbar-thumb { background-color: rgba(93, 64, 55, 0.3); border-radius: 3px; }
      .sidebar-content a { text-decoration: none; color: #6d4c41; display: block; padding: 6px 10px; border-radius: 6px; transition: all 0.2s; margin-bottom: 4px; font-size: 14px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sidebar-content a:hover { color: #3e2723; background: rgba(93, 64, 55, 0.1); }
      .sidebar-content a.current-chapter { color: #fff; background-color: var(--accent-bg); font-weight: bold; box-shadow: 0 2px 6px rgba(183, 28, 28, 0.3); }
      .main-wrapper { flex: 1; min-width: 0; height: 100%; background-color: var(--outer-bg); padding: 3vh 3vw; box-sizing: border-box; display: flex; justify-content: center; }
      .paper-container { width: 100%; max-width: 850px; height: 100%; background-color: var(--paper-bg); border-radius: 12px; box-shadow: 0 8px 30px rgba(93, 64, 55, 0.15); display: flex; flex-direction: column; overflow: hidden; position: relative; }
      .scroll-area { flex: 1; overflow-y: auto; scroll-behavior: smooth; scrollbar-width: thin; scrollbar-color: rgba(93, 64, 55, 0.2) transparent; }
      .scroll-area::-webkit-scrollbar { width: 6px; }
      .scroll-area::-webkit-scrollbar-thumb { background-color: rgba(93, 64, 55, 0.2); border-radius: 3px; }

      .article { padding: 50px 8%; font-size: 19px; line-height: 1.8; letter-spacing: 0.02em; text-align: justify; text-justify: inter-character; word-break: break-all; line-break: strict; }
      h1 { font-size: 2.2em; text-align: center; color: var(--highlight-color); margin: 0.5em 0 1.5em 0; font-weight: bold; line-height: 1.4; }
      h2 { font-size: 1.6em; font-weight: bold; color: #1a1a1a; margin: 2.5em 0 1.2em 0; padding-bottom: 0.5em; border-bottom: 2px solid rgba(93, 64, 55, 0.2); }
      h1 + h2, .article > h2:first-child { margin-top: 1em; }
      p { margin-bottom: 1.2em; text-indent: 2em; }
      .custom-divider { border: 0; height: 1px; background-image: linear-gradient(to right, rgba(0, 0, 0, 0), rgba(93, 64, 55, 0.4), rgba(0, 0, 0, 0)); margin: 3em 0; text-align: center; position: relative; }
      .custom-divider::after { content: "❖"; position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background-color: var(--paper-bg); padding: 0 10px; color: rgba(93, 64, 55, 0.6); font-size: 14px; }
      #reading-progress-bar { position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--highlight-color); transform-origin: 0 50%; transform: scaleX(0); z-index: 200; }

      /* 暗色模式下额外微调（暖色低眩光阅读主题） */
      body.dark-mode h2 { color: #ece5d8; border-bottom-color: rgba(236, 229, 216, 0.14); }
      body.dark-mode .sidebar-content a { color: #b7a894; }
      body.dark-mode .sidebar-content a:hover { color: #d8cbb6; background: rgba(255,255,255,0.06); }
      body.dark-mode .sidebar-content a.current-chapter { color: #f0c9a6; background-color: rgba(224, 163, 122, 0.14); box-shadow: inset 3px 0 0 #e0a37a; }
      body.dark-mode .export-btn:hover { background-color: #b85a34; box-shadow: 0 2px 6px rgba(224, 163, 122, 0.25); }
      body.dark-mode .export-btn:disabled { background-color: #3a352e; color: #8a8177; }
      body.dark-mode .paper-container { box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55); }
      body.dark-mode .sidebar { border-right-color: rgba(255, 255, 255, 0.08); }
      body.dark-mode .sidebar-header { border-bottom-color: rgba(255, 255, 255, 0.08); }
      body.dark-mode .sidebar-content { scrollbar-color: rgba(224, 199, 168, 0.25) transparent; }
      body.dark-mode .scroll-area { scrollbar-color: rgba(224, 199, 168, 0.2) transparent; }
      body.dark-mode .custom-divider { background-image: linear-gradient(to right, rgba(0,0,0,0), rgba(224, 199, 168, 0.22), rgba(0,0,0,0)); }
      body.dark-mode .custom-divider::after { color: rgba(224, 199, 168, 0.55); }
      body.dark-mode .sidebar-content::-webkit-scrollbar-thumb { background-color: rgba(224, 199, 168, 0.22); }
      body.dark-mode .scroll-area::-webkit-scrollbar-thumb { background-color: rgba(224, 199, 168, 0.18); }
    `;

    const DB_CONFIG = { name: 'TxtReaderCache', version: 1, store: 'RenderedFiles' };
    function openDB() { return new Promise((resolve, reject) => { const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version); request.onerror = () => reject('DB Error'); request.onsuccess = (e) => resolve(e.target.result); request.onupgradeneeded = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains(DB_CONFIG.store)) { db.createObjectStore(DB_CONFIG.store, { keyPath: 'key' }); } }; }); }
    async function getCache(key) { try { const db = await openDB(); return new Promise((resolve) => { const tx = db.transaction(DB_CONFIG.store, 'readonly'); const req = tx.objectStore(DB_CONFIG.store).get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(null); }); } catch (e) { return null; } }
    async function saveCache(key, html) { try { const db = await openDB(); const tx = db.transaction(DB_CONFIG.store, 'readwrite'); tx.objectStore(DB_CONFIG.store).put({ key, html, timestamp: Date.now(), version: PARSER_VERSION }); } catch (e) {} }
    async function deleteCache(key) { try { const db = await openDB(); const tx = db.transaction(DB_CONFIG.store, 'readwrite'); tx.objectStore(DB_CONFIG.store).delete(key); } catch (e) {} }

    // 启动时清理旧版本留下的渲染缓存（每个版本只扫描一次，由 GM 存储记录扫描标记）
    const CACHE_CLEAN_KEY = 'lastCacheCleanVersion';
    async function cleanupOldCache() {
        try {
            if (GM_getValue(CACHE_CLEAN_KEY, '') === PARSER_VERSION) return;
            const db = await openDB();
            const tx = db.transaction(DB_CONFIG.store, 'readwrite');
            const req = tx.objectStore(DB_CONFIG.store).openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) {
                    GM_setValue(CACHE_CLEAN_KEY, PARSER_VERSION);
                    return;
                }
                // 没有版本号（旧格式记录）或版本号不是当前版本的，都属于旧缓存
                const record = cursor.value;
                if (!record || record.version !== PARSER_VERSION) {
                    cursor.delete();
                }
                cursor.continue();
            };
            req.onerror = () => {};
        } catch (e) {}
    }

    // ========== 暗色模式管理 ==========
    const DARK_MODE_KEY = 'darkModeEnabled';
    function applyDarkMode(enabled) {
        if (enabled) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
    }
    function toggleDarkMode() {
        const current = document.body.classList.contains('dark-mode');
        const newState = !current;
        applyDarkMode(newState);
        GM_setValue(DARK_MODE_KEY, newState);
    }
    // 初始化暗色模式（在构建界面之前调用）
    function initDarkMode() {
        const saved = GM_getValue(DARK_MODE_KEY, false);
        applyDarkMode(saved);
    }
    // 注册菜单
    GM_registerMenuCommand("🌓 切换暗色模式", toggleDarkMode);
    // ====================================

    // ========== 原文模式管理 ==========
    const RAW_MODE_KEY = 'rawTextMode';
    function toggleRawTextMode() {
        GM_setValue(RAW_MODE_KEY, !GM_getValue(RAW_MODE_KEY, false));
        location.reload();
    }
    // 注册菜单
    GM_registerMenuCommand("🔄 原文模式（关闭自动纠错）", toggleRawTextMode);
    // ====================================

    window.addEventListener('load', async () => {
        GM_addStyle(STYLE);
        // 应用存储的暗色模式状态（此时 body 已存在）
        initDarkMode();

        const pre = document.querySelector('pre');
        if (!pre) return;

        const rawMode = GM_getValue(RAW_MODE_KEY, false);
        // 清理旧版本渲染缓存（异步执行，不影响本次渲染）
        cleanupOldCache();
        const fileKey = location.href + '_' + document.lastModified + '_' + pre.textContent.length + '_' + PARSER_VERSION + (rawMode ? '_raw' : '_smart');
        GM_registerMenuCommand("🧹 清除缓存并重载", async () => { if (confirm("确定要清除当前文件的缓存并重新处理吗？")) { await deleteCache(fileKey); location.reload(); } });

        let articleHtml = null;
        const cachedData = await getCache(fileKey);

        if (cachedData && cachedData.html) {
            articleHtml = cachedData.html;
        } else {
            let text = sanitizeText(pre.textContent);
            // 原文模式下不做任何内容修正（只做无字形字符清理）
            if (!rawMode) {
                text = text
                    .replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 65248))
                    // 逗号只在前后都是汉字时替换为全角，避免改坏数字（如 1,000）
                    .replace(/(?<=[\u4e00-\u9fa5]),(?:[ \t\u3000]*)(?=[\u4e00-\u9fa5])/g, '，')
                    .replace(/(\d)。(\d+)/g, '$1.$2')
                    .replace(/。{2,}/g, '……');
                // 统一章节编号风格（阿拉伯/中文混排、前导零）
                text = normalizeChapterNumbers(text);
            }

            const rawParas = stitchContinuousLines(text);
            const cleanedParas = rawParas.map(p => p.replace(/([。”」』…])[ \t\u3000]*[?？]+/g, '$1'));

            // 【新增】预处理段落数组，拆分内部章节标记
            const splitParas = splitInternalChapters(cleanedParas);

            // 汉字间空格清理放到章节拆分之后做，
            // 这样才能区分“章节标题里的空格”（保留）和“正文中的空格”（删除）
            const spacedParas = rawMode ? splitParas : splitParas.map(p => removeCjkSpacesSmart(p));
            // 拆分段落内残留的空隙（被并进同一行的对话回合，如“……？」　　「……”）
            // 以及无空隙直接粘连的对话回合（如“……”“……”），多人对话按回合独立成段
            const dialogueParas = splitAdjacentDialogue(splitParagraphSpacing(spacedParas));
            // 乱码“?!”把同一个词拆成两段时，源文件在“?!”中间可能恰好有分段/空行
            // （如“我感?”+“?受到”两行），段落拼接遇到空行会强制分段；这里把
            // 以 ?!/U+FFFD 开头、且上一段明显没写完的残段并回上一段，
            // 再清除正文中的 U+FFFD 替换字符（原文模式不做任何修正）
            const finalParas = (rawMode ? dialogueParas : mergeBrokenParas(dialogueParas))
                .map(p => rawMode ? p : p.replace(/\uFFFD/g, ''));

            const div = document.createElement('div');
            renderContent(div, finalParas);
            articleHtml = div.innerHTML;

            saveCache(fileKey, articleHtml);
        }

        const appContainer = document.createElement('div');
        appContainer.id = 'reader-app';

        const sidebar = document.createElement('div');
        sidebar.className = 'sidebar';

        const sidebarHeader = document.createElement('div');
        sidebarHeader.className = 'sidebar-header';
        const exportBtn = document.createElement('button');
        exportBtn.className = 'export-btn';
        exportBtn.innerHTML = '📚 导出为 EPUB';
        sidebarHeader.appendChild(exportBtn);

        const sidebarContent = document.createElement('div');
        sidebarContent.className = 'sidebar-content';

        sidebar.appendChild(sidebarHeader);
        sidebar.appendChild(sidebarContent);

        const mainWrapper = document.createElement('div');
        mainWrapper.className = 'main-wrapper';

        const paperContainer = document.createElement('div');
        paperContainer.className = 'paper-container';

        const scrollArea = document.createElement('div');
        scrollArea.className = 'scroll-area';
        scrollArea.id = 'main-scroll-area';

        const progressBar = document.createElement('div');
        progressBar.id = 'reading-progress-bar';

        const article = document.createElement('div');
        article.className = 'article';
        article.innerHTML = articleHtml;

        scrollArea.appendChild(article);
        paperContainer.appendChild(progressBar);
        paperContainer.appendChild(scrollArea);
        mainWrapper.appendChild(paperContainer);
        appContainer.appendChild(sidebar);
        appContainer.appendChild(mainWrapper);

        pre.replaceWith(appContainer);

        generateSidebar(sidebarContent, scrollArea);
        initProgressBar(scrollArea, progressBar);
        highlightCurrentChapter(scrollArea);
        enablePositionMemory(scrollArea);
        enablePageScroll(scrollArea);

        exportBtn.addEventListener('click', async () => {
            exportBtn.disabled = true;
            exportBtn.innerHTML = '⏳ 正在构建...';

            let overlay = document.getElementById('epub-progress-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'epub-progress-overlay';
                overlay.innerHTML = `
                    <div style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(15,15,15,0.95); z-index:999999; display:flex; flex-direction:column; justify-content:center; align-items:center; color:white; font-family:sans-serif;">
                        <h2 style="margin-bottom: 25px; font-weight:normal;">📚 正在构建 EPUB 电子书</h2>
                        <div style="width: 80%; max-width: 600px; background: #333; height: 24px; border-radius: 12px; overflow: hidden; border: 1px solid #555;">
                            <div id="epub-progress-bar" style="width: 0%; height: 100%; background: #4CAF50; transition: width 0.1s;"></div>
                        </div>
                        <p id="epub-progress-text" style="margin-top: 15px; font-size: 16px; color:#ddd;">启动中...</p>
                        <div id="epub-log" style="margin-top: 25px; width: 80%; max-width: 600px; height: 250px; background: #000; padding: 15px; border-radius: 8px; font-family: monospace; font-size: 13px; overflow-y: auto; color: #0f0; border: 1px solid #444; line-height: 1.6; text-align: left; box-shadow: inset 0 0 10px rgba(0,0,0,0.8);">
                        </div>
                        <button id="epub-close-btn" style="margin-top:25px; padding:10px 30px; font-size:15px; font-weight:bold; background:#b71c1c; color:white; border:none; border-radius:6px; cursor:pointer; display:none;">关闭面板</button>
                    </div>
                `;
                document.body.appendChild(overlay);
                document.getElementById('epub-close-btn').addEventListener('click', () => {
                    overlay.style.display = 'none';
                });
            }
            overlay.style.display = 'block';

            try {
                if (typeof fflate === 'undefined') {
                    throw new Error("下载打包依赖(fflate)失败，请检查网络。");
                }
                await executeEPUBGeneration(article);
            } catch (err) {
                console.error("[EPUB 崩溃]", err);
                epubLog(`❌ 发生崩溃: ${err.message}`);
                document.getElementById('epub-close-btn').style.display = 'block';
            } finally {
                exportBtn.disabled = false;
                exportBtn.innerHTML = '📚 导出为 EPUB';
            }
        });
    });

    function epubLog(msg) {
        console.log("[EPUB]", msg);
        const logContainer = document.getElementById('epub-log');
        if (logContainer) {
            const div = document.createElement('div');
            div.textContent = `> ${msg}`;
            logContainer.appendChild(div);
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    }

    function updateEpubProgress(percent, text) {
        const bar = document.getElementById('epub-progress-bar');
        const txt = document.getElementById('epub-progress-text');
        if (bar) bar.style.width = percent + '%';
        if (txt) txt.textContent = text;
    }

    const forcePaint = () => new Promise(r => setTimeout(r, 15));

    async function executeEPUBGeneration(articleElement) {
        epubLog("检查环境...");
        updateEpubProgress(5, "环境检测中...");
        await forcePaint();

        let bookTitle = "未命名书籍";
        const h1 = articleElement.querySelector('h1');
        if (h1 && h1.textContent.trim()) {
            bookTitle = h1.textContent.trim().replace(/[《》]/g, '');
        } else {
            const pathParts = decodeURIComponent(location.pathname).split('/');
            const fileName = pathParts[pathParts.length - 1].replace(/\.txt$/i, '');
            if (fileName) bookTitle = fileName;
        }

        epubLog(`开始提取正文节点...`);
        const children = articleElement.children;
        const total = children.length;
        const chapters = [];
        let currentChapter = { title: "前言", contentArr: [] };

        const BATCH_SIZE = 500;
        for (let i = 0; i < total; i++) {
            const el = children[i];
            const tag = el.tagName;
            const txt = el.textContent;

            if (tag === 'H2') {
                if (currentChapter.contentArr.length > 0 || currentChapter.title !== "前言") {
                    chapters.push({ title: currentChapter.title, content: currentChapter.contentArr.join('\n') });
                }
                currentChapter = { title: txt.trim(), contentArr: [`<h2>${escapeXml(txt)}</h2>`] };
            } else if (tag === 'P') {
                currentChapter.contentArr.push(`<p>${escapeXml(txt)}</p>`);
            } else if (tag === 'HR') {
                currentChapter.contentArr.push(`<hr class="custom-divider"/>`);
            } else if (tag === 'H1') {
                currentChapter.contentArr.push(`<h1>${escapeXml(txt)}</h1>`);
            }

            if (i % BATCH_SIZE === 0 || i === total - 1) {
                let pct = 10 + Math.floor((i / total) * 35);
                updateEpubProgress(pct, `提取结构：进度 ${Math.floor((i/total)*100)}%`);
                await forcePaint();
            }
        }

        if (currentChapter.contentArr.length > 0) {
            chapters.push({ title: currentChapter.title, content: currentChapter.contentArr.join('\n') });
        }

        epubLog(`结构解析完毕，共生成 ${chapters.length} 个章节。`);
        await forcePaint();

        const uuid = 'uuid-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();

        epubLog("正在构建文件树...");
        updateEpubProgress(60, "装配文件数据...");
        await forcePaint();

        const zipData = {};

        zipData["mimetype"] = fflate.strToU8("application/epub+zip");

        zipData["META-INF/container.xml"] = fflate.strToU8(
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>`);

        for (let idx = 0; idx < chapters.length; idx++) {
            const chapterHtml =
`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <title>${escapeXml(chapters[idx].title)}</title>
    <style>
        body { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.8; padding: 5%; color: #333; }
        p { text-indent: 2em; margin-bottom: 1.2em; text-align: justify; }
        h1, h2 { text-align: center; font-weight: bold; margin-bottom: 1em; color: #000; }
        .custom-divider { border: none; border-top: 1px dashed #999; margin: 2em 0; text-align: center; }
    </style>
</head>
<body>
    ${chapters[idx].content}
</body>
</html>`;
            zipData[`OEBPS/Text/chapter_${idx}.html`] = fflate.strToU8(chapterHtml);
        }

        const opfContent =
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
        <dc:title>${escapeXml(bookTitle)}</dc:title>
        <dc:language>zh-CN</dc:language>
        <dc:identifier id="BookId">urn:uuid:${uuid}</dc:identifier>
        <dc:creator>导出工具</dc:creator>
    </metadata>
    <manifest>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        ${chapters.map((c, i) => `<item id="chapter_${i}" href="Text/chapter_${i}.html" media-type="application/xhtml+xml"/>`).join('\n        ')}
    </manifest>
    <spine toc="ncx">
        ${chapters.map((c, i) => `<itemref idref="chapter_${i}"/>`).join('\n        ')}
    </spine>
</package>`;
        zipData["OEBPS/content.opf"] = fflate.strToU8(opfContent);

        const ncxContent =
`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
    <head>
        <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
        <meta name="dtb:depth" content="1"/>
        <meta name="dtb:totalPageCount" content="0"/>
        <meta name="dtb:maxPageNumber" content="0"/>
    </head>
    <docTitle><text>${escapeXml(bookTitle)}</text></docTitle>
    <navMap>
        ${chapters.map((c, i) => `
        <navPoint id="navPoint-${i}" playOrder="${i + 1}">
            <navLabel><text>${escapeXml(c.title)}</text></navLabel>
            <content src="Text/chapter_${i}.html"/>
        </navPoint>`).join('\n        ')}
    </navMap>
</ncx>`;
        zipData["OEBPS/toc.ncx"] = fflate.strToU8(ncxContent);

        epubLog("数据准备就绪，即将进行强行同步打包...");
        updateEpubProgress(80, "拼命运算中(约卡顿1-3秒)...");
        await forcePaint();

        const uint8Array = fflate.zipSync(zipData, { level: 0 });

        epubLog("✅ 打包完成！");
        updateEpubProgress(95, "生成最终文件...");
        await forcePaint();

        const finalFileName = bookTitle + ".epub";
        const contentBlob = new Blob([uint8Array], { type: "application/epub+zip" });
        const url = URL.createObjectURL(contentBlob);

        const a = document.createElement('a');
        a.href = url;
        a.download = finalFileName;
        a.style.display = 'none';
        document.body.appendChild(a);

        epubLog("✅ 下载已触发，请查看浏览器右上角下载记录。");
        a.click();

        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            updateEpubProgress(100, "导出完毕！");
            document.getElementById('epub-close-btn').style.display = 'block';
            document.getElementById('epub-close-btn').innerHTML = "完成并关闭";
            document.getElementById('epub-close-btn').style.background = "#4CAF50";
        }, 1000);
    }

    function escapeXml(unsafe) {
        if (!unsafe) return '';
        return String(unsafe).replace(/[<>&'"]/g, function (c) {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
            }
            return c;
        });
    }

    /**
     * 清理浏览器无法正常显示的字符（会渲染成方块 □）：
     * 1. 私用区 PUA（U+E000–U+F8FF、U+F0000–U+FFFFD、U+100000–U+10FFFD）：
     *    这类码点没有标准字形，任何字体都不保证提供，是 TXT 转换/采集过程留下的常见垃圾字符；
     * 2. 非字符（U+FDD0–U+FDEF 以及每个 Unicode 平面的最后两个码位 xxFFFE/xxFFFF）；
     * 3. 零宽/不可见字符（BOM、零宽空格等），避免悄悄混进正文。
     * 清理结果会输出到控制台，方便确认实际删掉的码点。
     */
    function sanitizeText(text) {
        const removed = [];
        const cleaned = Array.from(text).map(ch => {
            const cp = ch.codePointAt(0);
            const isPUA = (cp >= 0xE000 && cp <= 0xF8FF) ||
                          (cp >= 0xF0000 && cp <= 0xFFFFD) ||
                          (cp >= 0x100000 && cp <= 0x10FFFD);
            const isNonCharacter = (cp >= 0xFDD0 && cp <= 0xFDEF) || ((cp & 0xFFFE) === 0xFFFE);
            const isInvisibleJunk = cp === 0xFEFF || cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0x2060;
            if (isPUA || isNonCharacter || isInvisibleJunk) {
                if (removed.length < 50) removed.push('U+' + cp.toString(16).toUpperCase().padStart(4, '0'));
                return '';
            }
            return ch;
        }).join('');
        if (removed.length > 0) {
            console.log(`[txt format] 已清理 ${removed.length} 个无法显示的字符: ${removed.join(', ')}`);
        }
        return cleaned;
    }

    /**
     * 只清理“整段全是 ?！ 标点”的转换残留（2 个及以上），
     * 后面跟有正文（汉字等）的段落一律保留，避免误删合法内容。
     */
    function stripPunctOnlyArtifacts(s) {
        const t = String(s).trim();
        return /^[?？!！]{2,}$/.test(t) ? '' : t;
    }

    /**
     * 删除汉字之间的普通空格，但保留章节标题里的空格。
     * 1. 整段就是章节标题（“第X章 标题”且没有正文）时，标题内空格全部保留；
     * 2. 其他段落先用占位符保护“第X章/序章/尾声”后的空格，
     *    再删除其余汉字间空格，最后把占位符还原成空格。
     */
    function removeCjkSpacesSmart(text) {
        // 整段是章节标题：直接原样保留
        const chapterSplit = trySplitChapterLine(text);
        if (chapterSplit && !chapterSplit.body) {
            return text;
        }
        // 卷名 + “第X回” 的整行标题同样保留全部空格（如“龙潜于渊 第一回 临安会”）
        if (isVolPrefixChapterTitle(text)) {
            return text;
        }

        const HOLDER = '\uE000'; // 临时占位符（sanitizeText 已执行，不会再被清理）
        return String(text)
            .replace(/(第\s*[\d〇零一二三四五六七八九十百千万两]+\s*(?:卷|章|回|集|部|篇)|序章|尾声)[ \t\u3000]+/g, '$1' + HOLDER)
            .replace(/([\u4e00-\u9fa5])[ \t\u3000]+(?=[\u4e00-\u9fa5])/g, '$1')
            .replace(/\uE000/g, ' ');
    }

    /**
     * 统一章节编号风格。
     * 1. 先统计全书“第X章/卷/回/集/部/篇”使用的是阿拉伯数字还是中文数字；
     * 2. 以占多数的风格为准统一：
     *    - 阿拉伯风格默认去掉前导零；若全书存在前导零补齐风格（如 032、034），
     *      则统一按最大位数补齐（032/232 → 3 位）；
     *    - 中文风格把阿拉伯数字转成中文数字（第34章→第三十四章）；
     * 3. 平票时默认使用阿拉伯数字。
     */
    function normalizeChapterNumbers(text) {
        const tokenRe = /第\s*([\d０-９〇零一二三四五六七八九十百千万两]+)\s*(章|卷|回|集|部|篇)/g;
        const hasChineseDigit = (s) => /[〇零一二三四五六七八九十百千万两]/.test(s);
        const toAsciiDigits = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248));

        // 第一遍：统计风格并记录所有编号位置
        const tokens = [];
        let arabic = 0;
        let chinese = 0;
        let m;
        tokenRe.lastIndex = 0;
        while ((m = tokenRe.exec(text)) !== null) {
            const numStr = m[1];
            const style = hasChineseDigit(numStr) ? 'chinese' : 'arabic';
            if (style === 'chinese') chinese++; else arabic++;
            tokens.push({ start: m.index, end: m.index + m[0].length, numStr, unit: m[2], style });
        }
        if (tokens.length === 0) return text;

        const useArabic = arabic >= chinese; // 平票默认阿拉伯数字

        // 检测阿拉伯编号的前导零补齐风格：
        // 只要存在带前导零的编号（如 032），且全书阿拉伯编号最大位数为 W，
        // 就认为这本书习惯用 W 位补齐（032/232 都是 3 位），统一按 W 位输出。
        let padWidth = 0;
        if (useArabic) {
            let hasLeadingZero = false;
            let maxWidth = 0;
            for (const t of tokens) {
                if (t.style !== 'arabic') continue;
                const digits = toAsciiDigits(t.numStr);
                if (digits.length > 1 && digits[0] === '0') hasLeadingZero = true;
                maxWidth = Math.max(maxWidth, digits.length);
            }
            if (hasLeadingZero && maxWidth > 1) padWidth = maxWidth;
        }

        // 第二遍：按原顺序重写文本
        let result = '';
        let last = 0;
        for (const t of tokens) {
            result += text.slice(last, t.start);
            let number;
            if (t.style === 'arabic') {
                number = parseInt(toAsciiDigits(t.numStr), 10);
            } else {
                number = chineseNumToInt(t.numStr);
            }
            if (!isNaN(number)) {
                let numText;
                if (useArabic) {
                    numText = padWidth > 0 ? String(number).padStart(padWidth, '0') : String(number);
                } else {
                    numText = intToChineseNum(number);
                }
                result += '第' + numText + t.unit;
            } else {
                result += text.slice(t.start, t.end); // 解析失败则保留原文
            }
            last = t.end;
        }
        result += text.slice(last);
        return result;
    }

    /**
     * 中文数字转整数（支持 零一二三四五六七八九十百千万 及 两、〇）。
     * 例：三十二→32，一百零三→103，一万二千→12000。
     */
    function chineseNumToInt(str) {
        const digitMap = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
        const unitVal = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
        let result = 0;
        let section = 0;
        let num = 0;
        for (const ch of str) {
            if (Object.prototype.hasOwnProperty.call(digitMap, ch)) {
                num = digitMap[ch];
            } else if (Object.prototype.hasOwnProperty.call(unitVal, ch)) {
                const v = unitVal[ch];
                if (v >= 10000) {
                    result += (section + num) * v;
                    section = 0;
                    num = 0;
                } else {
                    section += (num || 1) * v;
                    num = 0;
                }
            }
        }
        return result + section + num;
    }

    /**
     * 整数转中文数字（支持 1~9999；≥10000 时保留数字原文）。
     * 例：32→三十二，103→一百零三，10→十。
     */
    function intToChineseNum(num) {
        if (num === 0) return '零';
        if (num >= 10000) return String(num);
        const digit = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
        const unit = ['', '十', '百', '千'];
        const s = String(num);
        let out = '';
        let zeroPending = false;
        for (let i = 0; i < s.length; i++) {
            const d = parseInt(s[i], 10);
            const pos = s.length - 1 - i;
            if (d === 0) {
                zeroPending = true;
            } else {
                if (zeroPending && out !== '') out += '零';
                zeroPending = false;
                out += digit[d] + unit[pos];
            }
        }
        if (out.startsWith('一十')) out = out.slice(1);
        return out;
    }

    function stitchContinuousLines(text) {
    const lines = text.split(/\r?\n/);
    const stitchedParas = []; let currentPara = '';
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);
    const indentedLines = nonEmptyLines.filter(l => /^[ \t\u3000]/.test(l));
    const useIndentLogic = nonEmptyLines.length > 0 && (indentedLines.length / nonEmptyLines.length) > 0.15;
    const isIndented = (str) => /^[ \t\u3000]/.test(str);
    // 只有真正的句末标点（可后跟右引号）才算句子结束；
    // 单独的右引号结尾不再算句末，避免 “你说什么” + 下一行叙述 被误拆成两段
    const isStopPunctuation = (str) => /[。！？…\u2026][”」』"]?$/.test(str.trim());
    const startsWithPunctuation = (str) => /^[，。；：！？…~、\?!\.,:;]/.test(str.trim());
    const startsWithSeparator = (str) => /^[\s\*\-=_~＊－＝＿～]{3,}/.test(str.trim());

    const isTitle = (str) => {
        const t = str.trim();
        if (t.length === 0) return false;
        if (/^第\s*[\d〇零一二三四五六七八九十百千万两]+\s*(?:卷|章|回|集|部|篇)/.test(t)) {
            // 正文句常出现两个及以上标记（如“第三章完成了，第四章也即将推出”），不算标题
            return t.length < 300 && countChapterMarkers(t) <= 1;
        }
        if (isVolPrefixChapterTitle(t)) return true;
        if (t.length > 100) return false;
        return isBracketNumberTitle(t) ||
               /^\d+\.?\s*$/.test(t) ||
               /^正文\s*【/.test(t) ||
               /^【\d+】/.test(t) ||
               /^《.+》/.test(t) ||
               /^序章|^尾声/.test(t) ||
               /^.+[（(][\d一二三四五六七八九十百千万]+[)）]\s*$/.test(t);
    };

    const getBracketBalance = (str) => { let balance = 0; const openSet = new Set(['(', '（', '【', '《', '〈', '〔', '[', '{', '｛', '［']); const closeSet = new Set([')', '）', '】', '》', '〉', '〕', ']', '}', '｝', '］']); for (const char of str) { if (openSet.has(char)) balance++; else if (closeSet.has(char)) balance--; } return balance; };

    for (let li = 0; li < lines.length; li++) {
        const rawLine = lines[li];
        const nextLine = lines[li + 1] || '';
        let trimmedLine = rawLine.trim();
        if (currentPara !== '') {
            const realLastChar = currentPara.replace(/[”’」』\s]+$/, '').slice(-1); const firstChar = trimmedLine.charAt(0);
            if ((/[?？]/.test(realLastChar) && /[!！]/.test(firstChar)) || (/[!！]/.test(realLastChar) && /[?？]/.test(firstChar))) {
                const match = trimmedLine.match(/^([?？!！]+)(.*)/); if (match) { currentPara += match[1]; trimmedLine = match[2]; }
            }
        }
        // 只清理“整行全是 ?！ 标点”的转换残留（2 个及以上），后面跟正文的行不再删
        if (/^[?？!！]{2,}$/.test(trimmedLine)) trimmedLine = '';
        if (trimmedLine === '') { if (currentPara && getBracketBalance(currentPara) <= 0) { stitchedParas.push(currentPara); currentPara = ''; } continue; }
        if (currentPara === '') {
            const glued = trySplitGluedBracketLine(trimmedLine, nextLine);
            if (glued) { stitchedParas.push(glued.title); currentPara = glued.body; } else { currentPara = trimmedLine; }
        } else {
            let shouldMerge = false;
            if (startsWithSeparator(currentPara) || startsWithSeparator(trimmedLine) ||
                isTitle(trimmedLine) || isTitle(currentPara) ||
                isFrontMatterLine(trimmedLine) || isFrontMatterLine(currentPara)) { shouldMerge = false; }
            else if (/^[\?!\.,:;？！，。；：”’」』)）】》〉〕\]\}｝］]/.test(trimmedLine) || getBracketBalance(currentPara) > 0 || startsWithPunctuation(trimmedLine)) { shouldMerge = true; }
            // 核心修复：当前一段以句末标点结束、且下一行以引号开头时，视为对话未闭合，强制合并
            else if (isStopPunctuation(currentPara) && /^["“「『]/.test(trimmedLine) && !/[。！？…\u2026][”」』"]$/.test(currentPara.trim())) { shouldMerge = true; }
            else if (!isStopPunctuation(currentPara) && !isTitle(currentPara) && !isFrontMatterLine(currentPara)) {
                if (currentPara.length < 500) {
                    shouldMerge = true;
                }
            }
            else if (useIndentLogic && !isIndented(rawLine)) { shouldMerge = true; }

            if (shouldMerge) {
                const isEng = c => /[a-zA-Z0-9]/.test(c); let joiner = (isEng(currentPara.slice(-1)) && isEng(trimmedLine[0])) ? ' ' : '';
                if (/^[\?!\.,:;？！，。；：]+$/.test(trimmedLine)) joiner = ''; currentPara += joiner + trimmedLine;
            } else {
                stitchedParas.push(currentPara);
                const glued = trySplitGluedBracketLine(trimmedLine, nextLine);
                if (glued) { stitchedParas.push(glued.title); currentPara = glued.body; } else { currentPara = trimmedLine; }
            }
        }
    }
    if (currentPara !== '') stitchedParas.push(currentPara); return stitchedParas;
}

    /**
     * 处理段落内部可能出现的章节标记（如“。」第二章”），
     * 将其拆分为两个段落：前面正文 + 独立章节行
     */
    function splitInternalChapters(paragraphs) {
        const result = [];
        // 匹配：句末标点或右引号/括号后紧跟“第X章/卷/回/集/部/篇”
        const chapterSplitter = /([。！？…\u2026”」』）】》〉〕\]\}｝］]) *(第\s*[\d〇零一二三四五六七八九十百千万两]+\s*(?:卷|章|回|集|部|篇))/g;

        for (const para of paragraphs) {
            // 先收集段落内所有章节标记，避免边遍历边推进时文本重复
            const matches = [];
            chapterSplitter.lastIndex = 0;
            let match;
            while ((match = chapterSplitter.exec(para)) !== null) {
                matches.push({ index: match.index, full: match[0], terminator: match[1], marker: match[2] });
            }

            if (matches.length === 0) {
                result.push(para);
                continue;
            }

            // 第一个标记前的正文（含它前面的句末标点）
            const before = para.slice(0, matches[0].index + matches[0].terminator.length);
            if (before.trim()) {
                result.push(before.trim());
            }

            // 每个章节行 = 章节标记 + 到下一个标记前为止的内容（含下一个标记前的句末标点）
            matches.forEach((m, i) => {
                const end = i + 1 < matches.length
                    ? matches[i + 1].index + matches[i + 1].terminator.length
                    : para.length;
                const after = para.slice(m.index + m.full.length, end);
                result.push((m.marker + after).trim());
            });
        }
        return result;
    }

    /** 统计未闭合引号数（“ ” 「 」 『 』 ‘ ’） */
    function quoteBalance(str) {
        let b = 0;
        for (const ch of str) {
            if (ch === '“' || ch === '「' || ch === '『' || ch === '‘') b++;
            else if (ch === '”' || ch === '」' || ch === '』' || ch === '’') b--;
        }
        return Math.max(0, b);
    }

    /**
     * 把段落内残留的“段落空隙”拆成独立段落。
     * 旧 txt 的段落缩进是两个全角空格（　　）；当对话回合被并进同一行时，
     * 这些空隙会残留在段落中间（如“……？」　　「……”），整段渲染成一行很难看。
     * 为避免误切正文，只在空隙满足以下条件时才拆：
     * 1. 空隙前以句末标点/闭合引号括号结尾，或空隙后以引号/括号开头；
     * 2. 空隙处没有未闭合的引号。
     */
    function splitParagraphSpacing(paragraphs) {
        const gapRe = /[ \t\u3000]{2,}/g;
        const prevBoundary = /[。！？…\u2026”」』）】》〉〕\]\}｝］]$/;
        const nextBoundary = /^[“「『‘（(【《]/;
        const result = [];
        for (const para of paragraphs) {
            gapRe.lastIndex = 0;
            let m;
            let last = 0;
            let split = false;
            const segs = [];
            while ((m = gapRe.exec(para)) !== null) {
                const prefix = para.slice(0, m.index);
                const after = para.slice(m.index + m[0].length);
                const isPrevBoundary = prevBoundary.test(prefix.slice(-1));
                const isNextBoundary = nextBoundary.test(after);
                if (quoteBalance(prefix) === 0 && (isPrevBoundary || isNextBoundary)) {
                    segs.push(para.slice(last, m.index).trim());
                    last = m.index + m[0].length;
                    split = true;
                }
            }
            if (!split) {
                result.push(para);
                continue;
            }
            segs.push(para.slice(last).trim());
            for (const s of segs) {
                if (s) result.push(s);
            }
        }
        return result;
    }

    /**
     * 把同一行内紧挨着的多个对话回合拆成独立段落。
     * 旧 txt 中对话回合常被并进同一行且不留空隙（如“……”“……”），
     * 中文里一个完整引号回合结束后不可能直接跟着另一个左引号，
     * 因此“右引号后紧跟左引号”几乎可以确定是换人说话。
     * 为避免误切：
     * 1. 边界前引号必须已闭合（quoteBalance 为 0）；
     * 2. 单引号（’‘）不参与，避免拆开嵌套引号里的连续引语；
     * 3. 拆出的片段非空才保留。
     */
    function splitAdjacentDialogue(paragraphs) {
        const turnRe = /([”」』])[ \t\u3000]*([“「『])/g;
        const result = [];
        for (const para of paragraphs) {
            turnRe.lastIndex = 0;
            let m;
            let last = 0;
            let split = false;
            const segs = [];
            while ((m = turnRe.exec(para)) !== null) {
                // prefix 含闭合引号：此时引号配平为 0 才算一个完整回合
                const prefix = para.slice(0, m.index + 1);
                if (quoteBalance(prefix) === 0) {
                    segs.push(para.slice(last, m.index + 1).trim());
                    // 只跳到闭合引号之后，把下一回合的左引号留给下一段
                    last = m.index + 1;
                    split = true;
                }
            }
            if (!split) {
                result.push(para);
                continue;
            }
            segs.push(para.slice(last).trim());
            for (const s of segs) {
                if (s) result.push(s);
            }
        }
        return result;
    }

    /**
     * 合并被乱码从中间拆开的相邻残段。
     * 源文件在“?!”或替换字符 U+FFFD（编码损坏时的 �）中间可能恰好有分段/空行
     * （如“我感?”+“?受到”两行），段落拼接阶段遇到空行会强制分段，
     * 导致“感受”这类词被分到两个段落。
     * 判定：当前段以 ?!/U+FFFD 开头，且上一段以同类字符或汉字结尾
     * （说明上一段没写完），此时把当前段并回上一段。
     */
    function mergeBrokenParas(paragraphs) {
        const JUNK_START = /^[?？!！\uFFFD]/;
        const JUNK_END = /[?？!！\uFFFD]$/;
        const result = [];
        for (const para of paragraphs) {
            const prev = result[result.length - 1];
            const prevT = prev !== undefined ? prev.trim() : '';
            // 上一段是章节标题/书籍信息行时不合并，避免标题被并进正文
            const prevIsTitle = prevT !== '' &&
                (/^第\s*[\d〇零一二三四五六七八九十百千万两]+\s*(?:卷|章|回|集|部|篇)/.test(prevT) ||
                 isVolPrefixChapterTitle(prevT) ||
                 cleanBracketNumberTitle(prevT) !== null ||
                 isFrontMatterLine(prevT));
            if (prev !== undefined && !prevIsTitle &&
                JUNK_START.test(para.trim()) &&
                (JUNK_END.test(prevT) || /[\u4e00-\u9fa5]$/.test(prevT))) {
                result[result.length - 1] = prevT + para.trim();
            } else {
                result.push(para);
            }
        }
        return result;
    }

    function trySplitChapterLine(text) {
        const match = text.match(/^(第\s*[\d〇零一二三四五六七八九十百千万两]+\s*(?:卷|章|回|集|部|篇))\s*(.*)$/);
        if (!match) return null;
        const prefix = match[1].trim();
        const suffix = match[2] ? match[2].trim() : '';
        // 只有“第X章”本身，或标题很短：整行作为标题
        if (!suffix || suffix.length <= 3) {
            return { title: text.trim(), body: null };
        }
        // 后缀含明确句末标点，说明后面是正文而非标题
        if (/[。！？；;?]/.test(suffix)) {
            return { title: prefix, body: suffix };
        }
        // 其余情况（含无标点的长标题）整行作为章节标题，不再按长度阈值误拆
        return { title: text.trim(), body: null };
    }

    /** 统计整行出现的“第X卷/章/回/集/部/篇”标记次数 */
    function countChapterMarkers(t) {
        const m = String(t).match(/第\s*[\d〇零一二三四五六七八九十百千万两]+\s*(?:卷|章|回|集|部|篇)/g);
        return m ? m.length : 0;
    }

    /**
     * 书籍信息行（元数据）：如“作者：快乐鸟”“书名：梅花三弄”“简介：……”。
     * 这类行是书名页/信息页的一部分，不是正文，段落拼接时必须保持独立，
     * 否则会被当成上一段/下一段的延续，出现“作者：快乐鸟命中注定……”这种粘连。
     * 判定约束：
     * 1. 行首是常见信息字段（作者/著者/书名/简介/更新状态等），后接全角或半角冒号；
     * 2. 整行不超过 60 字，排除正文里以这些词开头但内容很长的情况。
     */
    const FRONT_MATTER_RE = /^(?:作者|著者|原著|编者|译者|主编|书名|简介|内容简介|作品简介|总字数|更新时间|更新日期|更新于|连载状态|作品状态|作品类型|标签)\s*[:：]/;
    function isFrontMatterLine(text) {
        const s = String(text).trim();
        if (!s || s.length > 60) return false;
        return FRONT_MATTER_RE.test(s);
    }

    /**
     * 卷名 + 第X回/卷/集/部/篇 + 短标题 的独立标题行，如“龙潜于渊 第一回 临安会”。
     * 刻意不包含“章”：正文里“我把第三章完成了”这类句子太常见，误判风险高；
     * “章”格式的书通常直接用“第X章 标题”行首格式，由 ^第 分支处理。
     * 判定约束（全部满足才算标题）：
     * 1. 整行只出现 1 个“第X回/卷/集/部/篇”标记（正文句常出现两个及以上）；
     * 2. 行首是 1~12 字的不含标点卷名，与标记之间可紧贴，也可用 空格/·/： 分隔；
     * 3. 回目后缀 ≤ 24 字，且不含句读标点；
     * 4. 整行 ≤ 48 字；以引号开头的对话行不算。
     */
    function isVolPrefixChapterTitle(t) {
        const s = String(t).trim();
        if (s.length === 0 || s.length > 48) return false;
        if (/^["“「『]/.test(s)) return false;
        const markerRe = /第\s*[\d〇零一二三四五六七八九十百千万两]+\s*(?:回|卷|集|部|篇)/;
        const m = markerRe.exec(s);
        if (!m) return false;
        if (countChapterMarkers(s) !== 1) return false;
        const before = s.slice(0, m.index);
        const gapMatch = before.match(/[ \t\u3000·：]?$/);
        const gap = gapMatch ? gapMatch[0] : '';
        const prefix = before.slice(0, before.length - gap.length);
        const suffix = s.slice(m.index + m[0].length);
        if (!/^[^，。！？；、…：\s]{1,12}$/.test(prefix)) return false;
        if (!/^[ \t\u3000·：]{0,1}$/.test(gap)) return false;
        if (suffix.length > 24 || /[，。！？；、…：;:,.!?]/.test(suffix)) return false;
        return true;
    }

    /**
     * “（一）标题”式章节标题：括号编号 + 短后缀，且后缀不含句读标点。
     * 旧规则只要求行首是“（数字）”，会把“（六）杨门女将正当……，……”这类
     * 正文段落误判成标题；加上长度与标点约束后，只保留真正的短标题。
     * 同时剥离标题首尾的手打分隔符串（如“（十）＊＊＊＊＊＊”只取“（十）”）。
     */
    function cleanBracketNumberTitle(t) {
        const s = String(t).trim();
        const m = s.match(/^[（(][\d〇零一二三四五六七八九十百千万]+[)）]([\s\S]*)$/);
        if (!m) return null;
        let suffix = m[1];
        // 去掉标题首尾的分隔符串（＊ * - = _ ~ ～ － ＝ ＿ 及空白），作者常手打星号做分页
        suffix = suffix.replace(/^[＊\*\-=_~～－＝＿\s]+/, '').replace(/[＊\*\-=_~～－＝＿\s]+$/, '');
        if (suffix.length > 30) return null;
        if (/[，。！？；、：]/.test(suffix)) return null;
        return s.slice(0, s.length - m[1].length) + suffix;
    }

    function isBracketNumberTitle(t) {
        return cleanBracketNumberTitle(t) !== null;
    }

    /** 正文起始连接词：章回体/评书体正文常以这些词开篇 */
    const BODY_STARTERS = ['却说那', '且说那', '只见那', '但见那', '话说那', '再说那', '却说', '话说', '且说', '只见', '但见', '忽见', '又见', '忽听', '只听', '但听', '正待', '正当', '此时', '这日', '当日', '次日', '再说', '然而', '于是', '随后', '接着'];

    /** 跨行延续词：以此开头的行无法独立成句，必然承接上一行未写完的正文 */
    const CONTINUATION_STARTERS = ['之际', '之时', '的时候'];

    /**
     * “（数字）标题 + 正文粘连”行的拆分，如：
     *   （六）杨门女将正当西方诺曼人十字军东征，……（下一行：之际，……）
     * 拆成 标题“（六）杨门女将” + 正文“正当西方诺曼人……”。
     * 判定条件：
     * 1. 行内第一个正文起始词命中处之前的标题部分为 1~8 字、无标点无空白；
     * 2. 强信号：下一行以延续词开头（本行必然带着未写完的正文）；
     *    或弱信号：拆分后的正文含句读标点且长度足够（正文完整落在本行内）。
     * 条件不满足一律不拆，避免把正文误切成标题。
     */
    function trySplitGluedBracketLine(line, nextLine) {
        const s = String(line).trim();
        if (isBracketNumberTitle(s)) return null; // 已是完整短标题，无需拆分
        const m = s.match(/^[（(][\d〇零一二三四五六七八九十百千万]+[)）]([\s\S]*)$/);
        if (!m) return null;
        const bracket = s.slice(0, s.length - m[1].length);
        const suffix = m[1];

        const next = String(nextLine || '').trim();
        const hasContinuation = CONTINUATION_STARTERS.some(w => next.startsWith(w));

        let hit = null;
        for (const w of BODY_STARTERS) {
            const idx = suffix.indexOf(w);
            if (idx >= 0 && (hit === null || idx < hit.idx)) hit = { idx, w };
        }
        if (!hit) return null;

        const titleText = suffix.slice(0, hit.idx);
        const body = suffix.slice(hit.idx);
        if (titleText.length < 1 || titleText.length > 8) return null;
        if (/[，。！？；、：…\s＊\*\-=_~～－＝＿]/.test(titleText)) return null;
        if (!body.trim()) return null;
        // 没有跨行延续信号时，要求正文完整且足够“像正文”
        if (!hasContinuation && !(body.length >= 6 && /[，。！？；]/.test(body))) return null;
        return { title: bracket + titleText, body };
    }

    function splitTextSmartly(text) {
        const segments = []; let current = ''; let balance = 0; const openSet = new Set(['“', '‘', '「', '『', '(', '（', '【', '《', '〈', '〔', '[', '{', '｛', '［']); const closeSet = new Set(['”', '’', '」', '』', ')', '）', '】', '》', '〉', '〕', ']', '}', '｝', '］']);
        // 悬空引号处理：段末仍有未闭合的左引号时，多半是转换残留的“孤引号”
        // （只有“没有”，如“……“这样近距离”），它会一直占用引号配平数，
        // 导致整段无法按句子分段、渲染成铁板一块。
        // 但“说：“”“想着：“”等引语动词引出的对话，以及整段以左引号开头的
        // 引语，右引号可能在下一段，属于合法跨段对话，不能强行拆句。
        const quoteOpenSet = new Set(['“', '‘', '「', '『']);
        const quoteCloseSet = new Set(['”', '’', '」', '』']);
        let unclosedQuoteAtEnd = false;
        {
            let qb = 0; const quoteStarts = [];
            for (let qi = 0; qi < text.length; qi++) {
                const qch = text[qi];
                if (quoteOpenSet.has(qch)) { qb++; quoteStarts.push(qi); }
                else if (quoteCloseSet.has(qch)) { qb = Math.max(0, qb - 1); if (quoteStarts.length > 0) quoteStarts.pop(); }
            }
            if (qb > 0) {
                const lastStart = quoteStarts[quoteStarts.length - 1];
                const prefix = text.slice(0, lastStart);
                const speechVerb = /(?:说|道|问|答|喊|叫|唱|嚷|叹|哭|笑|骂|吼|怒|惊|应|想|念|低语|嘀咕|嘟囔|吩咐|告诉|回答|解释|补充|重复|警告|安慰|劝|哄|斥|唤|呼|吟|诵|读|背|曰)(?:着|了|过|道)?\s*[:：，,]?\s*$/;
                const startsWithQuote = quoteOpenSet.has(text.trim().charAt(0));
                unclosedQuoteAtEnd = !startsWithQuote && !speechVerb.test(prefix);
            }
        }
        for (let i = 0; i < text.length; i++) {
            const char = text[i]; current += char;
            if (openSet.has(char)) balance++; else if (closeSet.has(char)) balance = Math.max(0, balance - 1);
            // 句子结束符判定：
            // 1. 全角“。！？”：常规句末标点，算句子结束；
            // 2. 连续 2 个及以上的 ?! 串（全角/半角）夹在汉字中间时
            //    （如“感？？受到”“感??受到”），是转换乱码而非问句，整串不拆；
            // 3. 半角 ?! 单独出现时，只有两侧都不是汉字才按句子结束符处理（英文句）。
            const isCJK = (ch) => ch !== undefined && /[\u4e00-\u9fa5]/.test(ch);
            const isPunctRunBetweenCJK = (idx) => {
                if (!/[？?！!]/.test(text[idx])) return false;
                let s = idx, e = idx;
                while (s > 0 && /[？?！!]/.test(text[s - 1])) s--;
                while (e < text.length - 1 && /[？?！!]/.test(text[e + 1])) e++;
                return (e - s + 1 >= 2) && isCJK(text[s - 1]) && isCJK(text[e + 1]);
            };
            const isTerminator = (idx) => {
                const ch = text[idx];
                if (ch === '。' || ch === '！' || ch === '？') {
                    return !isPunctRunBetweenCJK(idx);
                }
                if (ch === '?' || ch === '!') {
                    return !isCJK(text[idx - 1]) && !isCJK(text[idx + 1]) && !isPunctRunBetweenCJK(idx);
                }
                return false;
            };
            if ((balance === 0 || unclosedQuoteAtEnd || current.length > 800) && isTerminator(i)) {
                let nextIdx = i + 1; while (nextIdx < text.length && closeSet.has(text[nextIdx])) { current += text[nextIdx]; i++; nextIdx++; balance = Math.max(0, balance - 1); }
                if (current.trim().length > 1) { segments.push(current); current = ''; }
            }
        }
        if (current) segments.push(current); return segments.filter(s => s.trim().length > 0);
    }

    function renderContent(container, paragraphs) {
    paragraphs.forEach((text, index) => {
        let t = stripPunctOnlyArtifacts(text); if (!t) return;
        const sepMatch = t.match(/^([\s\*\-=_~＊－＝＿～]{3,})(.*)$/s);
        if (sepMatch) { const hr = document.createElement('hr'); hr.className = 'custom-divider'; container.appendChild(hr); t = stripPunctOnlyArtifacts(sepMatch[2]); if (!t) return; }
        if (index < 10 && (/^《.+》/.test(t) || isFrontMatterLine(t))) { const h1 = document.createElement('h1'); h1.textContent = t; container.appendChild(h1); return; }

        // 章节标题智能拆分
        const chapterPattern = /^第\s*[\d〇零一二三四五六七八九十百千万两]+\s*(?:卷|章|回|集|部|篇)/;
        if (chapterPattern.test(t) && countChapterMarkers(t) <= 1) {
            const split = trySplitChapterLine(t);
            if (split) {
                const h2 = document.createElement('h2');
                h2.textContent = split.title;
                container.appendChild(h2);
                if (split.body) {
                    splitTextSmartly(split.body).forEach(seg => {
                        let clean = stripPunctOnlyArtifacts(seg);
                        if (clean) {
                            const p = document.createElement('p');
                            p.textContent = clean;
                            container.appendChild(p);
                        }
                    });
                }
                return;
            }
        }

        // 卷名 + 第X回/卷/集/部/篇 + 短标题（如“龙潜于渊 第一回 临安会”）
        if (isVolPrefixChapterTitle(t)) {
            const h2 = document.createElement('h2');
            h2.textContent = t;
            container.appendChild(h2);
            return;
        }

        // 其他标题模式
        const bracketTitle = cleanBracketNumberTitle(t);
        if (bracketTitle ||
            /^正文\s*【\d+】.*$/.test(t) ||
            /^【\d+】.*$/.test(t) ||
            /^序章|^尾声/.test(t) ||
            /^.+[（(][\d一二三四五六七八九十百千万]+[)）]\s*$/.test(t)) {
            const h2 = document.createElement('h2');
            h2.textContent = bracketTitle || t;
            container.appendChild(h2);
            return;
        }

        if (/^“[\s\S]*”$/.test(t)) {
            const p = document.createElement('p');
            p.textContent = t;
            container.appendChild(p);
            return;
        }

        // 普通正文（修复对话被误切的问题）
        const bodySegments = splitTextSmartly(t);
        let lastBodyP = null; // 追踪最近创建的正文 <p>

        for (const seg of bodySegments) {
            let cleanSeg = stripPunctOnlyArtifacts(seg);
            if (!cleanSeg) continue;

            // 纯标点（如：。”）时，附加到前一个段落
            if (/^[\?!\.,:;？！，。；：”’」』]+$/.test(cleanSeg) && !/^(\.\.\.|……)+$/.test(cleanSeg)) {
                const lastEl = container.lastElementChild;
                if (lastEl && lastEl.tagName === 'P' && !(/[。”」』]$/.test(lastEl.textContent.trim()) && /^[?？!！]/.test(cleanSeg))) {
                    lastEl.textContent += cleanSeg;
                    if (lastBodyP !== lastEl) lastBodyP = lastEl;
                } else {
                    const p = document.createElement('p');
                    p.textContent = cleanSeg;
                    container.appendChild(p);
                    lastBodyP = p;
                }
                continue;
            }

            // 核心修复：若该段以引号开头，且前一段末尾没有闭合右引号，则合并，避免对话被错误分段
            const startsWithQuote = /^["“「『”」』]/.test(cleanSeg);
            const prevEndsWithClosedQuote = lastBodyP && /[。！？…\u2026][”」』"]$/.test(lastBodyP.textContent.trim());

            if (startsWithQuote && lastBodyP && !prevEndsWithClosedQuote) {
                lastBodyP.textContent += cleanSeg;
                continue;
            }

            const p = document.createElement('p');
            p.textContent = cleanSeg;
            container.appendChild(p);
            lastBodyP = p;
        }
    });
}

    function generateSidebar(sidebarContainer, scrollContainer) {
        const headings = document.querySelectorAll('.article h2');
        if (!headings.length) { sidebarContainer.innerHTML = '<em style="padding:10px;display:block;">未检测到章节</em>'; } else {
            headings.forEach((h2, i) => {
                if (!h2.id) h2.id = 'heading-' + i;
                const a = document.createElement('a');
                a.href = '#' + h2.id; a.textContent = h2.textContent; a.title = h2.textContent;
                a.addEventListener('click', e => { e.preventDefault(); document.getElementById(h2.id).scrollIntoView({ behavior: 'smooth', block: 'start' }); });
                sidebarContainer.appendChild(a);
            });
        }
    }

    function initProgressBar(scrollContainer, barElement) {
        scrollContainer.addEventListener('scroll', () => {
            const totalHeight = scrollContainer.scrollHeight - scrollContainer.clientHeight;
            const progress = totalHeight > 0 ? (scrollContainer.scrollTop / totalHeight) : 0;
            barElement.style.transform = `scaleX(${progress})`;
        }, { passive: true });
    }

    function highlightCurrentChapter(scrollContainer) {
        const headings = Array.from(document.querySelectorAll('.article h2'));
        if (headings.length === 0) return;
        let ticking = false;
        scrollContainer.addEventListener('scroll', () => {
            if (!ticking) {
                window.requestAnimationFrame(() => {
                    let currentHeading = null;
                    for (const h of headings) {
                        const rect = h.getBoundingClientRect();
                        if (rect.top <= 180) { currentHeading = h; } else { break; }
                    }
                    if (currentHeading) {
                        const id = currentHeading.id;
                        document.querySelectorAll('.sidebar-content a.current-chapter').forEach(a => a.classList.remove('current-chapter'));
                        const link = document.querySelector(`.sidebar-content a[href="#${id}"]`);
                        if (link) {
                            link.classList.add('current-chapter');
                            link.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                    ticking = false;
                });
                ticking = true;
            }
        }, { passive: true });
    }

    function enablePositionMemory(scrollContainer) {
        const urlKey = 'scrollPos_' + location.href;
        const savedPosition = GM_getValue(urlKey, 0);
        if (savedPosition > 0) { setTimeout(() => scrollContainer.scrollTo({ top: savedPosition, behavior: 'smooth' }), 300); }
        let scrollTimeout;
        scrollContainer.addEventListener('scroll', () => { clearTimeout(scrollTimeout); scrollTimeout = setTimeout(() => { GM_setValue(urlKey, scrollContainer.scrollTop); }, 500); }, { passive: true });
    }

    function enablePageScroll(scrollContainer) {
        const pageOverlap = 40;
        const getPageHeight = () => scrollContainer.clientHeight - pageOverlap;
        document.addEventListener('keydown', function (e) {
            const tag = e.target.tagName.toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
            if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); scrollContainer.scrollBy({ top: -getPageHeight(), left: 0, behavior: 'smooth' }); }
            else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); scrollContainer.scrollBy({ top: getPageHeight(), left: 0, behavior: 'smooth' }); }
        });
    }

})();
