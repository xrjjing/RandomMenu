// 自定义 tabBar：4 个标签页（首页 / 菜谱 / 统计 / 更多）
Component({
  data: {
    value: '', // 初始值设置为空，避免第一次加载时闪烁
    list: [
      { icon: 'home', value: 'home', label: '首页' },
      { icon: 'app', value: 'menu', label: '菜谱' },
      { icon: 'chart', value: 'stats', label: '统计' },
      { icon: 'user', value: 'more', label: '更多' },
    ],
  },
  lifetimes: {
    ready() {
      // 依据当前页面路由解析激活的 tab
      const pages = getCurrentPages();
      const curPage = pages[pages.length - 1];
      if (!curPage) return;
      const nameRe = /pages\/(\w+)\/index/.exec(curPage.route);
      if (nameRe) {
        this.setData({ value: nameRe[1] });
      }
    },
  },
  methods: {
    handleChange(e) {
      const { value } = e.detail;
      wx.switchTab({ url: `/pages/${value}/index` });
    },
  },
});
