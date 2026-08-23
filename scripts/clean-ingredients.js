/**
 * scripts/clean-ingredients.js
 * 内置原料清洗脚本
 * 读取根目录 dishes.json / drinks.json:
 * - 用 splitIngredient 拆出原料名与用量
 * - 归并同义变体(姜丝/姜末→姜,蒜末→大蒜,葱花→小葱 等)
 * - 剔除非原料(清水/冰块 等水类)
 * - 修正脏数据(如「水果丁(芒果/火龙果)」→「什锦水果丁」)
 * - 调料标记(isSeasoning)
 * 输出 data/builtin-dishes.js(ES Module,export default)
 * 运行:node scripts/clean-ingredients.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeName, splitIngredient } from '../utils/normalize.js';
import { SEASONING_SET } from '../utils/seasonings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.join(__dirname, '..');
const DISHES_FILE = path.join(ROOT, 'dishes.json');
const DRINKS_FILE = path.join(ROOT, 'drinks.json');
const OUT_FILE = path.join(ROOT, 'data', 'builtin-dishes.js');

/** 同义变体归并映射:旧名 → 新名 */
const MERGE_MAP = {
  // 姜
  生姜: '姜',
  姜片: '姜',
  姜丝: '姜',
  姜末: '姜',
  姜蒜: '姜',
  // 蒜
  蒜瓣: '大蒜',
  蒜末: '大蒜',
  蒜片: '大蒜',
  蒜蓉: '大蒜',
  // 葱
  葱花: '小葱',
  葱末: '小葱',
  葱丝: '小葱',
  葱段: '大葱',
  葱姜末: '葱姜蒜末',
  // 豆腐
  嫩豆腐: '豆腐',
  北豆腐: '豆腐',
  // 菌菇
  干香菇: '香菇',
  鲜香菇: '香菇',
  干木耳: '木耳',
  黑木耳: '木耳',
  干紫菜: '紫菜',
  干海带: '海带',
  // 虾 / 鸡
  大虾: '虾',
  鲜虾: '虾',
  土鸡: '鸡',
  三黄鸡: '鸡',
  鸡翅中: '鸡翅',
  // 主食
  隔夜米饭: '米饭',
  挂面: '面条',
  细面条: '面条',
  手擀面: '面条',
  龙口粉丝: '粉丝',
  // 坚果
  熟花生米: '花生',
  花生碎: '花生',
  // 蔬菜
  长茄子: '茄子',
  小油菜: '油菜',
  胡萝卜丁: '胡萝卜',
  甜玉米: '玉米',
  玉米粒: '玉米',
  铁棍山药: '山药',
  青蒜苗: '蒜苗',
  // 肉
  猪肉馅: '猪肉末',
  肉末: '猪肉末',
  // 鱼
  胖头鱼鱼头: '鱼头',
  // 饮
  红茶包: '红茶',
  黑珍珠: '珍珠',
};

/** 脏数据修正映射:旧名 → 新名(兼容名称与用量间有/无空格两种形态) */
const FIX_MAP = {
  '水果丁（芒果/火龙果）': '什锦水果丁',
  '水果丁（芒果/火龙果）适量': '什锦水果丁',
};

/** 非原料(水类),直接剔除 */
const NON_FOOD_SET = new Set(['清水', '温水', '凉开水', '冰块', '开水', '凉水', '热水']);

/** 记录归并/修正/剔除日志 */
const mergeHits = new Map(); // 新名 -> 旧名数组
const fixLog = [];
const removedNames = new Set();
let removedCount = 0;

/**
 * 原料名解析:归一化 → 剔除 → 修正 → 归并。
 * @param {string} name 已归一化的原料名
 * @returns {string|null} 最终原料名;水类返回 null 表示剔除
 */
function resolveName(name) {
  if (NON_FOOD_SET.has(name)) {
    removedNames.add(name);
    removedCount += 1;
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(FIX_MAP, name)) {
    const to = FIX_MAP[name];
    fixLog.push({ from: name, to });
    return to;
  }
  if (Object.prototype.hasOwnProperty.call(MERGE_MAP, name)) {
    const to = MERGE_MAP[name];
    if (!mergeHits.has(to)) mergeHits.set(to, []);
    mergeHits.get(to).push(name);
    return to;
  }
  return name;
}

/**
 * 原料串解析:归一化 → 完整串脏数据修正 → 拆分 → 剔除 → 名称修正/归并。
 * @param {string} rawStr 原始原料串(如「西红柿 2个」)
 * @returns {{name: string, amount: string}|null} 最终原料;水类返回 null 表示剔除
 */
function resolveRawString(rawStr) {
  const normalized = normalizeName(rawStr);
  // 完整串级脏数据修正:名称与用量之间无空格(如「水果丁(芒果/火龙果)适量」)
  if (Object.prototype.hasOwnProperty.call(FIX_MAP, normalized)) {
    const to = FIX_MAP[normalized];
    fixLog.push({ from: normalized, to });
    return { name: to, amount: '' };
  }
  const { name, amount } = splitIngredient(rawStr);
  if (!name) return null;
  const finalName = resolveName(name);
  if (finalName === null) return null;
  return { name: finalName, amount };
}

/** 处理单个菜品,返回输出结构;category 统一为 meal/drink,tags 并入原分类与冷热饮类型 */
function processDish(raw, category) {
  const tags = [raw.category, raw.type].filter(Boolean);
  const ingredientMap = new Map(); // 最终名 -> { name, amount, isSeasoning }
  raw.ingredients.forEach((rawStr) => {
    const parsed = resolveRawString(rawStr);
    if (!parsed) return;
    const { name: finalName, amount } = parsed;
    const isSeasoning = SEASONING_SET.has(finalName);
    const prev = ingredientMap.get(finalName);
    if (prev) {
      // 同一道菜内归并后重名(如既有姜片又有姜末),用量合并展示
      prev.amount = prev.amount && amount ? `${prev.amount}、${amount}` : prev.amount || amount;
    } else {
      ingredientMap.set(finalName, { name: finalName, amount, isSeasoning });
    }
  });
  return {
    name: raw.name,
    category,
    tags,
    cookTime: raw.cookTime,
    difficulty: raw.difficulty,
    steps: raw.steps,
    ingredients: Array.from(ingredientMap.values()),
    isBuiltin: true,
  };
}

/** 主流程 */
function main() {
  const rawDishes = JSON.parse(fs.readFileSync(DISHES_FILE, 'utf8'));
  const rawDrinks = JSON.parse(fs.readFileSync(DRINKS_FILE, 'utf8'));

  const beforeNames = new Set(); // 归并前唯一原料名
  rawDishes.forEach((d) => d.ingredients.forEach((s) => beforeNames.add(splitIngredient(s).name)));
  rawDrinks.forEach((d) => d.ingredients.forEach((s) => beforeNames.add(splitIngredient(s).name)));

  const dishesOut = rawDishes.map((d) => processDish(d, 'meal'));
  const drinksOut = rawDrinks.map((d) => processDish(d, 'drink'));

  // 顶层原料清单:归并后去重,按拼音排序
  const finalMap = new Map();
  dishesOut.concat(drinksOut).forEach((dish) => {
    dish.ingredients.forEach((ing) => {
      if (!finalMap.has(ing.name)) finalMap.set(ing.name, { name: ing.name, isSeasoning: ing.isSeasoning });
    });
  });
  const ingredientsOut = Array.from(finalMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name, 'zh'),
  );

  // 写输出文件
  const builtin = { dishes: dishesOut.concat(drinksOut), ingredients: ingredientsOut };
  const content = `// 内置菜品数据(由 scripts/clean-ingredients.js 自动生成,请勿手改)\n// 生成时间:${new Date().toISOString()}\n\nexport default ${JSON.stringify(builtin, null, 2)};\n`;
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, content, 'utf8');

  // ---------- 打印报告 ----------
  console.log('=== 归并映射表(旧名 → 新名,供人工复核) ===');
  Object.keys(MERGE_MAP).forEach((from) => {
    const hit = mergeHits.get(MERGE_MAP[from]) || [];
    console.log(`  ${from} → ${MERGE_MAP[from]}${hit.includes(from) ? ' ✓' : ' - 未命中'}`);
  });

  console.log('\n=== 修正项 ===');
  if (fixLog.length === 0) console.log('  无');
  fixLog.forEach(({ from, to }) => console.log(`  ${from} → ${to}`));

  console.log('\n=== 剔除项(水类) ===');
  console.log(`  名称:${Array.from(removedNames).join('、') || '无'} 共 ${removedCount} 条`);

  console.log('\n=== 统计 ===');
  const mealCount = dishesOut.length;
  const drinkCount = drinksOut.length;
  const seasoningCount = ingredientsOut.filter((i) => i.isSeasoning).length;
  console.log(`  菜谱:餐食 ${mealCount} 道 / 饮品 ${drinkCount} 款`);
  console.log(`  原料数:归并前 ${beforeNames.size} → 归并后 ${ingredientsOut.length}`);
  console.log(`  剔除项数:${removedCount} 条(${removedNames.size} 个名称)`);
  console.log(`  调料数:${seasoningCount} 种`);
  if (ingredientsOut.length > 130) {
    console.warn('  ⚠️ 归并后原料总数超过 130,请补充归并映射');
  } else {
    console.log(`  归并后原料总数 ${ingredientsOut.length} ≤ 130 ✓`);
  }
  console.log(`\n已输出:${path.relative(ROOT, OUT_FILE)}`);
}

main();
