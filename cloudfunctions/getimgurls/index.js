// 云函数:批量换取云存储临时链接(服务端身份,不受存储安全规则约束)
// 入参 { fileIds: [cloud://...] } 出参 { map: { fileId: httpsUrl } }
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const fileIds = Array.isArray(event.fileIds) ? event.fileIds.slice(0, 50) : [];
  if (fileIds.length === 0) return { map: {} };
  const res = await cloud.getTempFileURL({ fileList: fileIds });
  const map = {};
  const failed = [];
  res.fileList.forEach((f) => {
    if (f.tempFileURL) {
      map[f.fileID] = f.tempFileURL;
    } else {
      failed.push(f.fileID);
    }
  });
  return { map, failed };
};
