// app.js
import { config } from './config/index';

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
    // 直查架构:冷启动不预热,页面 onShow 直接查云库取最新数据(多设备一致性优先)
  },
  globalData: {},
});
