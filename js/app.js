// 图片背景消除工具 - 核心逻辑

(function() {
    'use strict';

    // 配置
    const API_BASE_URL = 'https://image-bg-remover-xn3.pages.dev';
    const DAILY_LIMIT = 5;

    // DOM 元素
    const elements = {
        uploadArea: document.getElementById('uploadArea'),
        fileInput: document.getElementById('fileInput'),
        uploadSection: document.getElementById('uploadSection'),
        previewSection: document.getElementById('previewSection'),
        originalImage: document.getElementById('originalImage'),
        resultImage: document.getElementById('resultImage'),
        resultWrapper: document.getElementById('resultWrapper'),
        checkerboard: document.getElementById('checkerboard'),
        loadingSpinner: document.getElementById('loadingSpinner'),
        removeBgBtn: document.getElementById('removeBgBtn'),
        downloadBtn: document.getElementById('downloadBtn'),
        resetBtn: document.getElementById('resetBtn'),
        apiKeyInput: document.getElementById('apiKeyInput'),
        saveApiKeyBtn: document.getElementById('saveApiKeyBtn'),
        // 登录相关
        loginBtn: document.getElementById('loginBtn'),
        userInfo: document.getElementById('userInfo'),
        userAvatar: document.getElementById('userAvatar'),
        userName: document.getElementById('userName'),
        usageBadge: document.getElementById('usageBadge'),
        logoutBtn: document.getElementById('logoutBtn')
    };

    // 状态
    let currentFile = null;
    let processedBlob = null;
    let currentUser = null;
    let remainingUses = 0;

    // API Key 管理
    const API_KEY_STORAGE_KEY = 'remove_bg_api_key';

    /**
     * 初始化
     */
    function init() {
        loadApiKey();
        bindEvents();
        checkAuthStatus();
    }

    /**
     * 检查登录状态
     */
    async function checkAuthStatus() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/auth/status`, {
                credentials: 'include'
            });
            const data = await response.json();
            if (data.loggedIn && data.user) {
                currentUser = data.user;
                updateAuthUI(true);
                await checkUsage();
            } else {
                updateAuthUI(false);
            }
        } catch (error) {
            console.error('检查登录状态失败:', error);
            updateAuthUI(false);
        }
    }

    /**
     * 更新登录 UI
     */
    function updateAuthUI(loggedIn) {
        if (loggedIn) {
            elements.loginBtn.style.display = 'none';
            elements.userInfo.style.display = 'flex';
            elements.userAvatar.src = currentUser.avatar || '';
            elements.userName.textContent = currentUser.name || currentUser.email;
        } else {
            elements.loginBtn.style.display = 'block';
            elements.userInfo.style.display = 'none';
            currentUser = null;
            remainingUses = 0;
        }
    }

    /**
     * 检查使用次数
     */
    async function checkUsage() {
        if (!currentUser) return;
        try {
            const response = await fetch(`${API_BASE_URL}/api/usage`, {
                credentials: 'include'
            });
            const data = await response.json();
            if (data.loggedIn) {
                remainingUses = data.remaining;
                elements.usageBadge.textContent = `剩余 ${remainingUses} 次`;
            }
        } catch (error) {
            console.error('检查使用次数失败:', error);
        }
    }

    /**
     * 登录
     */
    function login() {
        window.location.href = `${API_BASE_URL}/api/auth/login`;
    }

    /**
     * 登出
     */
    async function logout() {
        try {
            await fetch(`${API_BASE_URL}/api/auth/logout`, {
                credentials: 'include'
            });
            currentUser = null;
            remainingUses = 0;
            updateAuthUI(false);
        } catch (error) {
            console.error('登出失败:', error);
        }
    }

    /**
     * 使用一次 API（扣除次数）
     */
    async function useApi() {
        if (!currentUser) {
            alert('请先登录');
            login();
            return false;
        }

        if (remainingUses <= 0) {
            alert('今日使用次数已用完，请明天再来');
            return false;
        }

        try {
            const response = await fetch(`${API_BASE_URL}/api/usage/use`, {
                method: 'POST',
                credentials: 'include'
            });
            const data = await response.json();
            if (data.success) {
                remainingUses--;
                elements.usageBadge.textContent = `剩余 ${remainingUses} 次`;
                return true;
            }
        } catch (error) {
            console.error('使用 API 失败:', error);
        }
        return false;
    }

    /**
     * 加载保存的 API Key
     */
    function loadApiKey() {
        const savedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
        if (savedKey) {
            elements.apiKeyInput.value = savedKey;
        }
    }

    /**
     * 保存 API Key
     */
    function saveApiKey() {
        const apiKey = elements.apiKeyInput.value.trim();
        if (!apiKey) {
            alert('请输入 API Key');
            return;
        }
        localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
        alert('API Key 已保存');
    }

    /**
     * 绑定事件
     */
    function bindEvents() {
        // 上传区域点击
        elements.uploadArea.addEventListener('click', () => elements.fileInput.click());

        // 文件输入变化
        elements.fileInput.addEventListener('change', handleFileSelect);

        // 拖拽上传
        elements.uploadArea.addEventListener('dragover', handleDragOver);
        elements.uploadArea.addEventListener('dragleave', handleDragLeave);
        elements.uploadArea.addEventListener('drop', handleDrop);

        // 按钮点击
        elements.removeBgBtn.addEventListener('click', removeBackground);
        elements.downloadBtn.addEventListener('click', downloadImage);
        elements.resetBtn.addEventListener('click', resetApp);
        elements.saveApiKeyBtn.addEventListener('click', saveApiKey);

        // 登录相关
        elements.loginBtn.addEventListener('click', login);
        elements.logoutBtn.addEventListener('click', logout);
    }

    /**
     * 处理文件选择
     */
    function handleFileSelect(e) {
        const file = e.target.files[0];
        if (file) {
            processFile(file);
        }
    }

    /**
     * 处理拖拽悬停
     */
    function handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        elements.uploadArea.style.borderColor = 'var(--accent-primary)';
        elements.uploadArea.style.background = 'var(--bg-card-hover)';
    }

    /**
     * 处理拖拽离开
     */
    function handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        elements.uploadArea.style.borderColor = 'var(--border-color)';
        elements.uploadArea.style.background = 'var(--bg-card)';
    }

    /**
     * 处理拖拽放下
     */
    function handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        elements.uploadArea.style.borderColor = 'var(--border-color)';
        elements.uploadArea.style.background = 'var(--bg-card)';

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            if (file.type.startsWith('image/')) {
                processFile(file);
            } else {
                alert('请上传图片文件');
            }
        }
    }

    /**
     * 处理文件
     */
    function processFile(file) {
        // 验证文件类型
        if (!file.type.match(/image\/(jpeg|png)/)) {
            alert('请上传 JPG 或 PNG 格式的图片');
            return;
        }

        // 验证文件大小 (最大 10MB)
        if (file.size > 10 * 1024 * 1024) {
            alert('图片大小不能超过 10MB');
            return;
        }

        currentFile = file;

        // 显示预览
        const reader = new FileReader();
        reader.onload = function(e) {
            elements.originalImage.src = e.target.result;
            elements.uploadSection.style.display = 'none';
            elements.previewSection.style.display = 'block';

            // 重置结果区域
            elements.resultImage.style.display = 'none';
            elements.checkerboard.style.display = 'block';
            elements.downloadBtn.disabled = true;
            elements.removeBgBtn.disabled = false;
        };
        reader.readAsDataURL(file);
    }

    /**
     * 消除背景
     */
    async function removeBackground() {
        // 检查登录和使用次数
        if (!currentUser) {
            alert('请先登录');
            login();
            return;
        }

        if (remainingUses <= 0) {
            alert('今日使用次数已用完，请明天再来');
            return;
        }

        const apiKey = elements.apiKeyInput.value.trim();
        if (!apiKey) {
            alert('请先输入并保存 Remove.bg API Key');
            elements.apiKeyInput.focus();
            return;
        }

        if (!currentFile) {
            alert('请先上传图片');
            return;
        }

        // 显示加载状态
        elements.loadingSpinner.style.display = 'block';
        elements.checkerboard.style.display = 'none';
        elements.resultImage.style.display = 'none';
        elements.removeBgBtn.disabled = true;

        try {
            // 调用 remove.bg API
            const formData = new FormData();
            formData.append('image_file', currentFile);
            formData.append('size', 'auto');
            formData.append('format', 'png');

            const response = await fetch('https://api.remove.bg/v1.0/removebg', {
                method: 'POST',
                headers: {
                    'X-Api-Key': apiKey
                },
                body: formData
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API 请求失败: ${response.status} - ${errorText}`);
            }

            // 获取处理后的图片
            processedBlob = await response.blob();
            const imageUrl = URL.createObjectURL(processedBlob);

            // 显示结果
            elements.resultImage.onload = function() {
                elements.loadingSpinner.style.display = 'none';
                elements.resultImage.style.display = 'block';
                elements.downloadBtn.disabled = false;
                elements.removeBgBtn.disabled = false;
            };
            elements.resultImage.src = imageUrl;

        } catch (error) {
            console.error('消除背景失败:', error);
            elements.loadingSpinner.style.display = 'none';
            elements.checkerboard.style.display = 'block';
            elements.removeBgBtn.disabled = false;
            alert('消除背景失败: ' + error.message);
        }
    }

    /**
     * 下载图片
     */
    function downloadImage() {
        if (!processedBlob) {
            return;
        }

        const url = URL.createObjectURL(processedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'removed-bg-' + Date.now() + '.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * 重置应用
     */
    function resetApp() {
        currentFile = null;
        processedBlob = null;

        elements.fileInput.value = '';
        elements.originalImage.src = '';
        elements.resultImage.src = '';
        elements.previewSection.style.display = 'none';
        elements.uploadSection.style.display = 'flex';
        elements.downloadBtn.disabled = true;
        elements.removeBgBtn.disabled = false;
    }

    // 启动应用
    init();
})();