// app.js
import { config } from './config/index';
import { preloadCoreData } from './api/db';

App({
  onLaunch() {
    // 云开发初始化（基础库需 >= 2.2.3）
    if (!wx.cloud) {
      console.error('当前基础库版本过低，无法使用云能力，请升级微信基础库');
      return;
    }
    wx.cloud.init({
      env: config.envId,
      traceUser: true,
    });
    // 首屏预热:异步拉核心数据填充三层缓存(不阻塞首屏;页面自己请求时会先查 L2 加速)
    preloadCoreData();
  },
  globalData: {},
});
