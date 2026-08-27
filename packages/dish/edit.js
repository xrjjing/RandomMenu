/**
 * packages/dish/edit.js
 * 菜品新增 / 编辑页
 * - 编辑模式:options.id → getDish 回填,标题「编辑菜品」;新增模式标题「新增菜品」
 * - 表单:菜名(必填)、大类 radio(切换清空已选细分标签)、细分 tags chips 多选 + 自定义、
 *   cookTime / difficulty picker
 * - 图片九宫格:已选缩略图 + ➕ 格;chooseAndUploadImages 上传;被移除图片保存成功后 deleteImages 清理
 * - 原料:半屏弹层搜索勾选(防抖调 listIngredients)+ 无结果即时新增(保存时 saveDish 统一 ensure);用量输入
 * - 步骤:动态列表(上移/下移/删除/添加)
 * - 保存:菜名空拦截 → checkDishName 查重(命中且非本菜 → t-dialog 确认)→ saveDish → toast → 返回
 * 数据库操作一律走 api/db.js / api/upload.js,页面不直接调用 wx.cloud。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import { getDish, saveDish, checkDishName, listIngredients } from '../../api/db.js';
import { chooseAndUploadImages, deleteImages } from '../../api/upload.js';
import { normalizeName } from '../../utils/normalize.js';
import { SEASONING_SET } from '../../utils/seasonings.js';
import { isCloudFileId } from '../../utils/image.js';
import { resolveImgUrls } from '../../utils/imgUrl.js';

/** 每菜图片上限 */
const MAX_IMAGES = 5;

/** 细分标签固定选项(餐食 + 饮品,供 chips 多选) */
const COMMON_TAGS = [
  '主食', '汤羹', '猪肉', '禽肉', '鱼虾', '素菜', '蛋类',
  '鲜榨果汁', '奶茶', '奶昔', '果茶', '咖啡拿铁', '养生热饮',
  '豆浆米糊', '甜品饮品', '消暑饮品', '冷饮', '热饮',
];

/** 烹饪时间选项 */
const COOK_TIME_OPTIONS = ['10分钟', '15分钟', '20分钟', '30分钟', '45分钟', '60分钟'];

/** 难度选项 */
const DIFFICULTY_OPTIONS = ['简单', '中等', '较难'];

Page({
  behaviors: [useToastBehavior],

  data: {
    id: '', // 菜品 _id(空为新增)
    loading: true, // 编辑模式回填加载态
    saving: false, // 保存中(防重复提交)
    name: '', // 菜名
    category: 'meal', // 大类:meal 餐食 / drink 饮品
    tagChips: COMMON_TAGS.map((name) => ({ name, active: false })), // 细分标签 chips(固定选项 + 自定义已选,含选中态)
    selectedTags: [], // 已选细分标签
    customTag: '', // 自定义标签输入
    cookTime: '', // 烹饪时间(如 10分钟)
    difficulty: '', // 难度(简单/中等/较难)
    cookTimeVisible: false, // 烹饪时间选择器
    difficultyVisible: false, // 难度选择器
    cookTimeOptions: COOK_TIME_OPTIONS.map((v) => ({ label: v, value: v })),
    difficultyOptions: DIFFICULTY_OPTIONS.map((v) => ({ label: v, value: v })),
    MAX_IMAGES, // 图片上限(供 wxml 展示)
    images: [], // 图片 fileID 列表(数据源:保存写库/删除清理用,保持原 cloud:// fileID)
    displayImages: [], // 缩略图显示列表(images 换链后的 https 临时链接,仅展示用)
    ingredients: [], // 已选原料 [{id?, name, amount, isSeasoning}]
    steps: [{ id: 0, text: '' }], // 做法步骤 [{id, text}]
    popupVisible: false, // 原料选择弹层
    searchKw: '', // 原料搜索关键字
    quickAddIsSeasoning: false, // 即时新增默认调料标记(搜索词变化时按调料表重算,用户可手动改)
    ingredientCandidates: [], // 原料搜索结果(带 checked 标记)
    duplicateVisible: false, // 重名确认弹窗
  },

  onLoad(options) {
    const id = options.id || '';
    this.setData({ id });
    this.originalImages = []; // 编辑模式初始图片
    this.removedFileIds = []; // 本次编辑中被移除的图片(保存成功后清理)
    this.originalName = ''; // 编辑模式初始菜名(归一化,查重时排除自己)
    this.searchTimer = null; // 原料搜索防抖定时器
    this.stepSeq = 1; // 步骤 id 计数器

    if (id) {
      wx.setNavigationBarTitle({ title: '编辑菜品' });
      this.loadDish(id);
    } else {
      wx.setNavigationBarTitle({ title: '新增菜品' });
      this.setData({ loading: false });
    }
  },

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  },

  /** 编辑模式:拉取菜品详情回填表单 */
  async loadDish(id) {
    try {
      const dish = await getDish(id);
      this.originalImages = (dish.images || []).slice();
      this.originalName = normalizeName(dish.name);
      // 原料明细兜底:老数据可能只有 ingredientNames 无用量明细
      const ingredients =
        dish.ingredients && dish.ingredients.length
          ? dish.ingredients
          : (dish.ingredientNames || []).map((name) => ({
              id: '',
              name,
              amount: '',
              isSeasoning: SEASONING_SET.has(name),
            }));
      const steps =
        dish.steps && dish.steps.length
          ? dish.steps.map((text, i) => ({ id: i, text }))
          : [{ id: 0, text: '' }];
      this.stepSeq = steps.length;
      const selectedTags = dish.tags || [];
      this.setData({
        name: dish.name,
        category: dish.category === 'drink' ? 'drink' : 'meal',
        tagChips: this.buildTagChips(selectedTags),
        selectedTags,
        cookTime: dish.cookTime || '',
        difficulty: dish.difficulty || '',
        images: this.originalImages.slice(),
        ingredients,
        steps,
        loading: false,
      });
      // 回显缩略图换链(非创建者手机也能看到已有图片)
      this.setData({ displayImages: await resolveImgUrls(this.data.images) });
    } catch (err) {
      console.error('菜品加载失败', err);
      this.setData({ loading: false });
      this.onShowToast('#t-toast', '加载失败，请重试');
    }
  },

  /** 组装标签 chips:固定选项 + 自定义已选(去重),每个 chip 带选中态;保证自定义标签可见可取消 */
  buildTagChips(selectedTags) {
    const custom = selectedTags.filter((tag) => !COMMON_TAGS.includes(tag));
    return COMMON_TAGS.concat(custom).map((name) => ({
      name,
      active: selectedTags.includes(name),
    }));
  },

  /* ---------------- 基础表单 ---------------- */

  onNameChange(e) {
    this.setData({ name: e.detail.value });
  },

  /** 大类切换:清空已选细分标签(餐食/饮品标签体系不同) */
  onCategoryChange(e) {
    const category = e.detail.value;
    if (category === this.data.category) return;
    this.setData({ category, selectedTags: [], tagChips: this.buildTagChips([]) });
  },

  /** 细分标签 chips 点击:多选切换 */
  onTagTap(e) {
    const { value } = e.currentTarget.dataset;
    const selectedTags = this.data.selectedTags.includes(value)
      ? this.data.selectedTags.filter((tag) => tag !== value)
      : this.data.selectedTags.concat(value);
    this.setData({ selectedTags, tagChips: this.buildTagChips(selectedTags) });
  },

  onCustomTagInput(e) {
    this.setData({ customTag: e.detail.value });
  },

  /** 输入框回车:新增自定义标签 */
  onCustomTagConfirm(e) {
    this.addCustomTag(e.detail.value);
  },

  /** 「添加」按钮:新增自定义标签 */
  onCustomTagAdd() {
    this.addCustomTag(this.data.customTag);
  },

  /** 新增自定义标签:归一化、去重后加入已选 */
  addCustomTag(raw) {
    const tag = normalizeName(raw);
    if (!tag) return;
    if (this.data.selectedTags.includes(tag)) {
      this.setData({ customTag: '' });
      return;
    }
    const selectedTags = this.data.selectedTags.concat(tag);
    this.setData({ selectedTags, tagChips: this.buildTagChips(selectedTags), customTag: '' });
  },

  /** 打开烹饪时间选择器 */
  onCookTimeTap() {
    this.setData({ cookTimeVisible: true });
  },

  /** 打开难度选择器 */
  onDifficultyTap() {
    this.setData({ difficultyVisible: true });
  },

  /** 选择器确认:按 data-type 区分时间/难度 */
  onPickerConfirm(e) {
    const { type } = e.currentTarget.dataset;
    const value = (e.detail.value && e.detail.value[0]) || '';
    if (type === 'cookTime') {
      this.setData({ cookTime: value, cookTimeVisible: false });
    } else if (type === 'difficulty') {
      this.setData({ difficulty: value, difficultyVisible: false });
    }
  },

  /** 选择器取消:关闭两个选择器 */
  onPickerCancel() {
    this.setData({ cookTimeVisible: false, difficultyVisible: false });
  },

  /* ---------------- 图片 ---------------- */

  /** 点击 ➕ 格:选择并上传图片;超限拒绝的 toast 在此提示 */
  async onAddImage() {
    if (this.data.images.length >= MAX_IMAGES) return;
    try {
      const { fileIds, rejected } = await chooseAndUploadImages(this.data.images.length, MAX_IMAGES);
      if (fileIds.length) {
        this.setData({ images: this.data.images.concat(fileIds) });
        // 新增图即时换链补进显示列表(其余走缓存,零额外调用)
        this.setData({ displayImages: this.data.displayImages.concat(await resolveImgUrls(fileIds)) });
      }
      if (rejected.length) {
        this.onShowToast('#t-toast', `${rejected.length} 张超过 1M 无法压缩，已跳过`);
      }
    } catch (err) {
      console.error('图片上传失败', err);
      this.onShowToast('#t-toast', '上传失败，请重试');
    }
  },

  /** 点击缩略图:全屏预览 */
  onPreviewImage(e) {
    const { index } = e.currentTarget.dataset;
    const { displayImages } = this.data;
    if (displayImages.length === 0) return;
    wx.previewImage({ current: displayImages[index], urls: displayImages });
  },

  /** 缩略图右上 ✕:从列表移除,记录云存储 fileID 待保存成功后清理(本地静态路径不属于云存储,不清理) */
  onRemoveImage(e) {
    const { index } = e.currentTarget.dataset;
    const images = this.data.images.slice();
    const [removed] = images.splice(index, 1);
    if (removed && isCloudFileId(removed)) this.removedFileIds.push(removed);
    const displayImages = this.data.displayImages.slice();
    displayImages.splice(index, 1);
    this.setData({ images, displayImages });
  },

  /* ---------------- 原料 ---------------- */

  /** 打开原料选择弹层:重置搜索并拉全量候选 */
  openIngredientPopup() {
    this.setData({ popupVisible: true, searchKw: '', ingredientCandidates: [] });
    this.searchIngredients('');
  },

  /** 弹层显隐变化:关闭时同步状态 */
  onPopupVisibleChange(e) {
    if (!e.detail.visible) this.setData({ popupVisible: false });
  },

  /** 原料搜索输入:防抖 300ms 后模糊过滤;每次搜索词变化重算「设为调料」默认值
   *  (调料表命中默认勾上,用户可手动改,onQuickAddIngredient 使用该值) */
  onIngredientSearch(e) {
    const kw = (e.detail.value || '').trim();
    this.setData({ searchKw: kw, quickAddIsSeasoning: SEASONING_SET.has(normalizeName(kw)) });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.searchIngredients(kw), 300);
  },

  /** 拉取原料候选(带已选标记) */
  async searchIngredients(kw) {
    try {
      const candidates = await listIngredients(kw);
      const ingredientCandidates = candidates.map((item) => ({
        _id: item._id,
        name: item.name,
        isSeasoning: !!item.isSeasoning,
        checked: this.data.ingredients.some((ing) => ing.name === item.name),
      }));
      this.setData({ ingredientCandidates });
    } catch (err) {
      console.error('原料搜索失败', err);
      this.onShowToast('#t-toast', '操作失败，请重试');
    }
  },

  /** 候选行点击:勾选 / 取消 */
  onIngredientToggle(e) {
    const { id, name } = e.currentTarget.dataset;
    const exists = this.data.ingredients.find((ing) => ing.name === name);
    let ingredients;
    if (exists) {
      ingredients = this.data.ingredients.filter((ing) => ing.name !== name);
    } else {
      ingredients = this.data.ingredients.concat([
        { id: id || '', name, amount: '', isSeasoning: SEASONING_SET.has(name) },
      ]);
    }
    this.setData({ ingredients });
    this.syncCandidateChecked(ingredients);
  },

  /** 搜索无结果「➕ 新增原料」:即时加入已选(保存时 saveDish 内部 ensureIngredient 统一落库)。
   *  isSeasoning 优先取弹层里「设为调料」勾选值,未显式操作时回退调料表命中判断 */
  onQuickAddIngredient() {
    const name = normalizeName(this.data.searchKw);
    if (!name || this.data.ingredients.some((ing) => ing.name === name)) return;
    const isSeasoning = this.data.quickAddIsSeasoning ?? SEASONING_SET.has(name);
    const ingredients = this.data.ingredients.concat([
      { id: '', name, amount: '', isSeasoning },
    ]);
    // 关弹层 + 清搜索词 + 清调料标记 + toast 反馈:一次 setData 完成状态收尾,避免弹层残留与无反馈
    this.setData({ ingredients, popupVisible: false, searchKw: '', quickAddIsSeasoning: false });
    this.onShowToast('#t-toast', `已添加「${name}」`);
  },

  /** 「设为调料」勾选变化:仅更新标记,不触发新增 */
  onQuickAddSeasoningChange(e) {
    this.setData({ quickAddIsSeasoning: !!e.detail.checked });
  },

  /** 调料勾选区点击占位:catch:tap 阻断冒泡,避免勾选时误触整行「新增原料」 */
  onQuickAddSeasoningTap() {},

  /** 「完成」按钮 / 标题 ✕ 关闭:收口弹层,关弹层 + 清搜索词(与即时新增收尾一致) */
  onIngredientDone() {
    this.setData({ popupVisible: false, searchKw: '' });
  },

  /** 刷新候选列表 checked 状态(与已选保持一致) */
  syncCandidateChecked(ingredients) {
    this.setData({
      ingredientCandidates: this.data.ingredientCandidates.map((c) => ({
        ...c,
        checked: ingredients.some((ing) => ing.name === c.name),
      })),
    });
  },

  /** 用量输入变化 */
  onAmountChange(e) {
    const { index } = e.currentTarget.dataset;
    const ingredients = this.data.ingredients.slice();
    ingredients[index] = { ...ingredients[index], amount: e.detail.value };
    this.setData({ ingredients });
  },

  /** 删除已选原料行 */
  onRemoveIngredient(e) {
    const { index } = e.currentTarget.dataset;
    const ingredients = this.data.ingredients.filter((_, i) => i !== index);
    this.setData({ ingredients });
    this.syncCandidateChecked(ingredients);
  },

  /* ---------------- 步骤 ---------------- */

  /** 步骤文本变化 */
  onStepChange(e) {
    const { index } = e.currentTarget.dataset;
    const steps = this.data.steps.slice();
    steps[index] = { ...steps[index], text: e.detail.value };
    this.setData({ steps });
  },

  /** 步骤上移(与上一步交换) */
  onStepUp(e) {
    const { index } = e.currentTarget.dataset;
    if (index <= 0) return;
    const steps = this.data.steps.slice();
    [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
    this.setData({ steps });
  },

  /** 步骤下移(与下一步交换) */
  onStepDown(e) {
    const { index } = e.currentTarget.dataset;
    if (index >= this.data.steps.length - 1) return;
    const steps = this.data.steps.slice();
    [steps[index], steps[index + 1]] = [steps[index + 1], steps[index]];
    this.setData({ steps });
  },

  /** 删除步骤(至少保留一行) */
  onStepRemove(e) {
    const { index } = e.currentTarget.dataset;
    const steps = this.data.steps.filter((_, i) => i !== index);
    this.setData({ steps: steps.length ? steps : [{ id: this.stepSeq++, text: '' }] });
  },

  /** 添加步骤 */
  onAddStep() {
    this.setData({ steps: this.data.steps.concat([{ id: this.stepSeq++, text: '' }]) });
  },

  /* ---------------- 保存 ---------------- */

  /** 保存:菜名空拦截 → 查重(命中且非本菜弹确认)→ doSave */
  async onSave() {
    if (this.data.saving) return;
    const name = normalizeName(this.data.name);
    if (!name) {
      this.onShowToast('#t-toast', '请输入菜名');
      return;
    }
    // 编辑模式且菜名未变:自己命中自己不算重复,跳过查重
    if (this.data.id && name === this.originalName) {
      this.doSave();
      return;
    }
    try {
      const duplicated = await checkDishName(name);
      if (duplicated) {
        this.setData({ duplicateVisible: true });
        return;
      }
      this.doSave();
    } catch (err) {
      console.error('菜名查重失败', err);
      this.onShowToast('#t-toast', '操作失败，请重试');
    }
  },

  /** 重名确认弹窗取消 */
  onDuplicateCancel() {
    this.setData({ duplicateVisible: false });
  },

  /** 重名确认弹窗确认:继续保存 */
  onDuplicateConfirm() {
    this.doSave();
  },

  /** 实际执行保存:saveDish(内部 ensure 原料/组装关联)→ 清理被移除图片 → toast → 返回 */
  async doSave() {
    this.setData({ saving: true, duplicateVisible: false });
    const { id, name, category, selectedTags, cookTime, difficulty, images, ingredients, steps } =
      this.data;
    const payload = {
      name: normalizeName(name),
      category,
      tags: selectedTags,
      cookTime,
      difficulty,
      images,
      ingredients: ingredients.map((ing) => ({
        id: ing.id || undefined,
        name: ing.name,
        amount: ing.amount || '',
        isSeasoning: ing.isSeasoning,
      })),
      steps: steps.map((s) => s.text.trim()).filter(Boolean),
    };
    if (id) payload.id = id;
    try {
      await saveDish(payload);
      // 清理本次编辑中被移除的图片(删除失败不阻断主流程)
      await deleteImages(this.removedFileIds);
      this.onShowToast('#t-toast', '已保存');
      setTimeout(() => wx.navigateBack(), 800);
    } catch (err) {
      console.error('保存菜品失败', err);
      this.setData({ saving: false });
      this.onShowToast('#t-toast', '操作失败，请重试');
    }
  },
});
