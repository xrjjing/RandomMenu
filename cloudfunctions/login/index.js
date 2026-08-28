// 云函数:获取调用者微信 openid(小程序端身份体系的基础,不可由客户端伪造)
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  return { openid: OPENID };
};
