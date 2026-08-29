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

const { getAiConfig } = require('./ai/config.js');
const { generateDishImage, attachImageToDish } = require('./ai/api.js');
const { generateRecipeDraftStream } = require('./ai/recipe.js');
const { generateDishFill } = require('./ai/fill.js');
const { DEFAULT_PROMPTS, buildImagePrompt } = require('./ai/prompts.js');

/** 每菜图片上限 */
const MAX_IMAGES = 5;

/** 细分标签固定选项(餐食 + 饮品,供 chips 多选) */
const COMMON_TAGS = [
  '主食',
  '汤羹',
  '猪肉',
  '禽肉',
  '鱼虾',
  '素菜',
  '蛋类',
  '鲜榨果汁',
  '奶茶',
  '奶昔',
  '果茶',
  '咖啡拿铁',
  '养生热饮',
  '豆浆米糊',
  '甜品饮品',
  '消暑饮品',
  '冷饮',
  '热饮',
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
    aiImageEnabled: false, // AI 生图入口开关(新建/编辑统一拉取,F29)
    aiPopupVisible: false, // AI 生图弹层
    aiPrompt: '', // 生图提示词
    aiGenerating: false, // 生成中(防重复点击)
    aiPreviewUrl: '', // 生成图预览临时链接(fileID 换链后)
    aiPreviewFileId: '', // 生成图 cloud:// fileID(采用时写入 dishes.images)
    aiUseRefImage: false, // F30 #8 图生图:是否参考第一张现有图片(以现有图为底生成)
    aiError: '', // 生成/采用失败文案(卡片内红字)
    aiRecipeEnabled: false, // AI 写做法入口开关(仅编辑模式拉取,跟 textEnabled)
    // AI 写做法弹层三态:input(填入菜名/要点)/ generating(流式生成中)/ result(展示全文待覆盖或放弃)
    recipePopupVisible: false, // AI 写做法确认弹层
    recipeHint: '', // 补充"特色/要点"(可跳过)
    recipeGenerating: false, // 生成中(防重复)
    recipeStreamText: '', // F30 #7 流式回显(生成中实时累计的草稿预览)
    recipeResult: '', // 生成结果(非空 = result 态,展示全文,可由用户覆盖/放弃)
    aiFillLoading: false, // AI 补全信息生成中(防重复)
  },

  onLoad(options) {
    const id = options.id || '';
    this.setData({ id });
    this.originalImages = []; // 编辑模式初始图片
    this.removedFileIds = []; // 本次编辑中被移除的图片(保存成功后清理)
    this.originalName = ''; // 编辑模式初始菜名(归一化,查重时排除自己)
    this.searchTimer = null; // 原料搜索防抖定时器
    this.stepSeq = 1; // 步骤 id 计数器

    // AI 入口开关:新建/编辑都要(失败按 false,不弹错误);F29:新建模式同样可用
    getAiConfig()
      .then((cfg) => this.setData({ aiImageEnabled: cfg.imageEnabled, aiRecipeEnabled: cfg.textEnabled }))
      .catch(() => {});
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
        dish.steps && dish.steps.length ? dish.steps.map((text, i) => ({ id: i, text })) : [{ id: 0, text: '' }];
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

  /** AI 补全信息:根据菜名+原料推断分类/时间/难度/标签,填充表单(请核对后保存) */
  async onAiFill() {
    const dishName = (this.data.name || '').trim();
    if (!dishName) {
      this.onShowToast('#t-toast', '请先填写菜名');
      return;
    }
    if (this.data.aiFillLoading) return;
    this.setData({ aiFillLoading: true });
    try {
      const res = await generateDishFill({
        name: dishName,
        ingredients: this.data.ingredients,
      });
      if (!res.ok) {
        this.onShowToast('#t-toast', res.error);
        this.setData({ aiFillLoading: false });
        return;
      }
      const d = res.data || {};
      // 固定枚举校验:不合法值保持原值,只接受预定义选项
      const category = d.category === 'drink' || d.category === 'meal' ? d.category : this.data.category;
      const cookTime = COOK_TIME_OPTIONS.includes(d.cookTime) ? d.cookTime : this.data.cookTime;
      const difficulty = DIFFICULTY_OPTIONS.includes(d.difficulty) ? d.difficulty : this.data.difficulty;
      const selectedTags = Array.isArray(d.tags)
        ? d.tags.filter((tag) => COMMON_TAGS.includes(tag)).slice(0, 3)
        : this.data.selectedTags; // 模型漏出 tags 时保留用户已选,与其它字段「非法保留原值」一致
      this.setData({
        category,
        cookTime,
        difficulty,
        selectedTags,
        tagChips: this.buildTagChips(selectedTags),
        aiFillLoading: false,
      });
      this.onShowToast('#t-toast', '已补全，请核对后保存');
    } catch (err) {
      console.error('AI 补全信息失败', err);
      this.setData({ aiFillLoading: false });
      this.onShowToast('#t-toast', err.message || '补全失败，请重试');
    }
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
    // 等价 `??`:显式 false(用户手动取消「设为调料」)保留 false,不回退调料表判定
    const isSeasoning =
      this.data.quickAddIsSeasoning !== null && this.data.quickAddIsSeasoning !== undefined
        ? this.data.quickAddIsSeasoning
        : SEASONING_SET.has(name);
    const ingredients = this.data.ingredients.concat([{ id: '', name, amount: '', isSeasoning }]);
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
    let steps = this.data.steps.filter((_, i) => i !== index);
    if (steps.length === 0) {
      steps = [{ id: this.stepSeq, text: '' }];
      this.stepSeq += 1;
    }
    this.setData({ steps });
  },

  /** 添加步骤 */
  onAddStep() {
    const id = this.stepSeq;
    this.stepSeq += 1;
    this.setData({ steps: this.data.steps.concat([{ id, text: '' }]) });
  },

  /* ---------------- AI 生图 ---------------- */

  /** 打开 AI 生图弹层:预填菜名 + 固定风格后缀 + 可编辑风格词根(F28 改读 config),用户可改 */
  async onOpenAiPopup() {
    const base = `${this.data.name}美食摄影,俯拍,自然光,真实风格`;
    let style = DEFAULT_PROMPTS.imageStyle;
    try {
      const cfg = await getAiConfig();
      style = cfg.prompts.imageStyle;
    } catch (err) {
      // 读配置失败按内置默认词根,不阻断弹层打开
    }
    this.setData({
      aiPopupVisible: true,
      aiError: '',
      aiUseRefImage: false,
      aiPrompt: buildImagePrompt(base, style),
    });
  },

  /** 图生图开关(F30 #8):只有菜肴已有图片时才有意义,开关联动第一张现有图 */
  onAiUseRefImageChange(e) {
    this.setData({ aiUseRefImage: !!e.detail.value });
  },

  /** AI 弹层遮罩关闭 */
  onAiPopupVisibleChange(e) {
    if (!e.detail.visible) this.setData({ aiPopupVisible: false });
  },

  /** 生图提示词输入 */
  onAiPromptChange(e) {
    this.setData({ aiPrompt: e.detail.value });
  },

  /** 生成/重新生成:loading 防重复,成功后换链展示预览,失败卡片内红字 */
  async onAiGenerate() {
    if (this.data.aiGenerating) return;
    const prompt = (this.data.aiPrompt || '').trim();
    if (!prompt) {
      this.setData({ aiError: '请先填写图片描述' });
      return;
    }
    this.setData({ aiGenerating: true, aiError: '' });
    try {
      const fileID = await generateDishImage(prompt, {
        // F30 #8 图生图:开关开启且有现有图时,以第一张现有图为参考(云函数侧转 I2I 模型)
        imageFileId: this.data.aiUseRefImage && this.data.images.length > 0 ? this.data.images[0] : '',
      });
      const urls = await resolveImgUrls([fileID]);
      this.setData({ aiPreviewFileId: fileID, aiPreviewUrl: urls[0] || '', aiGenerating: false });
    } catch (err) {
      console.error('AI 生图失败', err);
      this.setData({ aiGenerating: false, aiError: err.message || '生图失败，请重试' });
    }
  },

  /** 采用:编辑模式写库(updated!==1 视为未写入);新增模式只入本地待保存数组(随 doSave 一起提交)→ 刷新九宫格 → 关弹层 */
  async onAiAdopt() {
    const { id, aiPreviewFileId, aiPreviewUrl, images } = this.data;
    if (!aiPreviewFileId) return;
    if (images.length >= MAX_IMAGES) {
      this.setData({ aiError: `最多 ${MAX_IMAGES} 张图片` });
      return;
    }
    if (!id) {
      // 新增模式:菜品还不存在,图先入本地待保存列表,保存菜品时一并入库
      this.setData({
        images: images.concat(aiPreviewFileId),
        displayImages: aiPreviewUrl ? this.data.displayImages.concat(aiPreviewUrl) : this.data.displayImages,
        aiPopupVisible: false,
        aiPreviewUrl: '',
        aiPreviewFileId: '',
        aiError: '',
      });
      this.onShowToast('#t-toast', '已添加，保存菜品后生效');
      return;
    }
    try {
      const updated = await attachImageToDish(id, aiPreviewFileId);
      if (updated !== 1) {
        this.setData({ aiError: '保存失败，请重试' });
        return;
      }
      this.setData({
        images: images.concat(aiPreviewFileId),
        displayImages: aiPreviewUrl ? this.data.displayImages.concat(aiPreviewUrl) : this.data.displayImages,
        aiPopupVisible: false,
        aiPreviewUrl: '',
        aiPreviewFileId: '',
        aiError: '',
      });
      this.onShowToast('#t-toast', '已添加');
    } catch (err) {
      console.error('AI 图保存失败', err);
      this.setData({ aiError: '保存失败，请重试' });
    }
  },

  /** 放弃:关弹层并清预览(仅页面态,不删云存储文件,由用户在图库自行清理) */
  onAiDiscard() {
    this.setData({ aiPopupVisible: false, aiPreviewUrl: '', aiPreviewFileId: '', aiError: '' });
  },

  /* ---------------- AI 写做法(F28,草稿定位) ---------------- */

  /** 打开确认弹层:展示将使用的菜名,可补充要点后生成 */
  onOpenRecipePopup() {
    this.setData({ recipePopupVisible: true, recipeHint: '', recipeStreamText: '', recipeResult: '', aiError: '' });
  },

  /** 确认弹层遮罩关闭 */
  onRecipePopupVisibleChange(e) {
    if (!e.detail.visible) this.setData({ recipePopupVisible: false });
  },

  /** 补充要点输入 */
  onRecipeHintChange(e) {
    this.setData({ recipeHint: e.detail.value });
  },

  /** 取消:关弹层 */
  onRecipeCancel() {
    this.setData({ recipePopupVisible: false });
  },

  /** 生成:调 generateRecipeDraftStream;成功后不关弹层,进入 result 态展示全文,失败 toast */
  async onRecipeGenerate() {
    if (this.data.recipeGenerating) return;
    const name = (this.data.name || '').trim();
    if (!name) {
      this.onShowToast('#t-toast', '请先填写菜名');
      return;
    }
    this.setData({ recipeGenerating: true, recipeStreamText: '', recipeResult: '' });
    try {
      // F30 #7 流式:逐段回显到弹层「正在生成」预览区,完成后展示在 result 态(不自动关闭)
      const res = await generateRecipeDraftStream(name, this.data.recipeHint, (chunk) => {
        this.setData({ recipeStreamText: this.data.recipeStreamText + chunk });
      });
      if (!res.ok) {
        this.setData({ recipeGenerating: false, recipeStreamText: '' });
        this.onShowToast('#t-toast', res.error || '生成失败，请重试');
        return;
      }
      this.setData({ recipeGenerating: false, recipeStreamText: '', recipeResult: res.text });
    } catch (err) {
      // 理论上 recipe.js 已收口,防御性兜底
      console.error('AI 写做法失败', err);
      this.setData({ recipeGenerating: false, recipeStreamText: '' });
      this.onShowToast('#t-toast', '生成失败，请重试');
    }
  },

  /** 结果态「覆盖填入」:关弹层并直接填入做法(不再弹第二次确认) */
  onRecipeApply() {
    const text = this.data.recipeResult;
    this.setData({ recipePopupVisible: false, recipeResult: '', recipeStreamText: '', recipeHint: '' });
    if (text) this.applyRecipeDraft(text);
  },

  /** 结果态「放弃」:关弹层并清空结果(仅页面态,不动现有步骤) */
  onRecipeDiscard() {
    this.setData({ recipePopupVisible: false, recipeResult: '', recipeStreamText: '' });
  },

  /** 把草稿按行拆入做法步骤(由结果态「覆盖填入」触发,静默覆盖不弹二次确认) */
  applyRecipeDraft(text) {
    const lines = String(text)
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) {
      wx.showToast({ title: '生成失败，请重试', icon: 'none' });
      return;
    }
    const base = this.stepSeq;
    this.stepSeq += lines.length;
    this.setData({ steps: lines.map((t, i) => ({ id: base + i, text: t })) });
    wx.showToast({ title: '已填入草稿', icon: 'none' });
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
    const { id, name, category, selectedTags, cookTime, difficulty, images, ingredients, steps } = this.data;
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
