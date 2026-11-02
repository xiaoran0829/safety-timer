<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  ElButton,
  ElTable,
  ElTableColumn,
  ElTag,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElSelect,
  ElOption,
  ElOptionGroup,
  ElDatePicker,
  ElCheckbox,
  ElTabs,
  ElTabPane,
  ElRadioGroup,
  ElRadioButton,
  ElAlert,
  ElMessage,
  ElMessageBox,
} from 'element-plus';
import { approvals, adminUsers } from '@/api';
import { useAdminStore, ROLE_LABEL } from '@/stores/admin';
import type { AdminRole } from '@/types';

const store = useAdminStore();
const isAdmin = computed(() => store.isAdmin);

const tab = ref('todo');
const todoList = ref<any[]>([]);
const mineList = ref<any[]>([]);
const flows = ref<any[]>([]);
const flowOpts = ref<any[]>([]);
const opts = ref<any>({ vehicles: [], users: [], organizations: [], suppliers: [], activeSessions: [], scope: null });
const users = ref<any[]>([]);
const loading = ref(false);

const KIND_LABEL: Record<string, string> = { org_change: '换组织/供应商', force_stop: '强制结束工单', task_delay: '任务延时' };
function fmt(s?: string | null) {
  return s ? s.replace('T', ' ').slice(0, 19) : '—';
}
function nameOf(list: any[], id: number | null | undefined) {
  if (id == null) return '—';
  const it = list.find((x) => x.id === id);
  return it ? it.name : `#${id}`;
}

async function loadTodo() {
  todoList.value = await approvals.requests({ scope: 'todo', status: 'pending' });
}
async function loadMine() {
  mineList.value = await approvals.requests({ scope: 'mine' });
}
async function loadFlows() {
  if (!isAdmin.value) return; // 流程配置仅管理员
  flows.value = await approvals.flows();
  users.value = await adminUsers.list({ active: 1 }).catch(() => []);
}
async function loadSubmitMeta() {
  const [fo, op] = await Promise.all([approvals.flowOptions(), approvals.options()]);
  flowOpts.value = (fo as any[]).filter((f) => f.submittable !== false);
  opts.value = op;
}

async function refresh() {
  loading.value = true;
  try {
    await Promise.all([loadTodo(), loadMine()]);
  } finally {
    loading.value = false;
  }
}

async function act(row: any, action: 'approve' | 'reject') {
  let comment = '';
  try {
    const r = await ElMessageBox.prompt(action === 'approve' ? '审批意见（可空）' : '驳回原因', action === 'approve' ? '通过' : '驳回', {
      inputPlaceholder: action === 'reject' ? '请填写驳回原因' : '可空',
      inputValidator: (v: string) => (action === 'reject' && !String(v || '').trim() ? '驳回必须填写原因' : true),
    });
    comment = r.value || '';
  } catch {
    return;
  }
  try {
    if (action === 'approve') await approvals.approve(row.id, comment);
    else await approvals.reject(row.id, comment);
    ElMessage.success(action === 'approve' ? '已通过' : '已驳回');
    refresh();
  } catch (e: any) {
    ElMessage.error(e.message || '操作失败');
  }
}

function targetText(p: any) {
  if (!p) return '—';
  if (p.workOrderNo) return `工单 ${p.workOrderNo}${p.vin ? '（' + p.vin + '）' : ''}`;
  if (p.vin) return `车架号 ${p.vin}`;
  if (p.targetUserId) return `账号 #${p.targetUserId}`;
  return '—';
}
function changeText(p: any) {
  if (!p) return '—';
  const parts: string[] = [];
  if (p.orgId != null) parts.push(`组织→${nameOf(opts.value.organizations, p.orgId)}`);
  if (p.supplierId != null) parts.push(`供应商→${nameOf(opts.value.suppliers, p.supplierId)}`);
  if (p.extendEndAt) parts.push(`任务结束时间→${fmt(p.extendEndAt)}`);
  if (p.remark) parts.push(`原因：${p.remark}`);
  return parts.join('，') || (p.remark ? `原因：${p.remark}` : '—');
}

/* ---- 发起申请（按流程自定义字段渲染） ---- */
const subShow = ref(false);
const subSaving = ref(false);
const subForm = ref<{ flowCode: string; values: Record<string, any> }>({ flowCode: '', values: {} });
const curFlow = computed(() => flowOpts.value.find((f) => f.code === subForm.value.flowCode));
const curFields = computed<any[]>(() => (curFlow.value?.fields || []) as any[]);

function fieldSrc(f: any) {
  if (f.source === 'vehicles') return opts.value.vehicles || [];
  if (f.source === 'organizations') return opts.value.organizations || [];
  if (f.source === 'suppliers') return opts.value.suppliers || [];
  if (f.source === 'users') return opts.value.users || [];
  if (f.source === 'active_sessions') return opts.value.activeSessions || [];
  return [];
}
function fieldOpts(f: any) {
  const d = fieldSrc(f);
  if (f.source === 'vehicles')
    return d.map((v: any) => ({
      value: v.vin,
      label: `${v.vin}（${v.orgName || '—'} / ${v.supplierName || '—'}）${v.busy ? ' · 有未完结工单' : ''}`,
      disabled: !!v.busy,
    }));
  if (f.source === 'users') return d.map((u: any) => ({ value: u.id, label: `${u.name}（${ROLE_LABEL[(u.role || 'admin') as AdminRole]}）` }));
  if (f.source === 'active_sessions')
    return d.map((s: any) => ({
      value: s.id,
      label: `${s.vin} · ${s.operatorName}`,
    }));
  return d.map((x: any) => ({ value: x.id, label: x.name }));
}

async function openSubmit() {
  await loadSubmitMeta();
  const first = flowOpts.value[0];
  subForm.value = { flowCode: first ? first.code : '', values: {} };
  subShow.value = true;
}
async function saveSubmit() {
  const f = curFlow.value;
  if (!f) return ElMessage.warning('请选择流程');
  for (const fd of curFields.value) {
    const v = subForm.value.values[fd.key];
    if (fd.required && (v === undefined || v === null || v === '')) return ElMessage.warning(`请填写${fd.label}`);
  }
  subSaving.value = true;
  try {
    await approvals.submit({ kind: f.code, ...subForm.value.values } as any);
    subShow.value = false;
    ElMessage.success('已提交，等待审批');
    refresh();
  } catch (e: any) {
    ElMessage.error(e.message || '提交失败');
  } finally {
    subSaving.value = false;
  }
}

/* ---- 流程配置：全流程自定义（步骤 / 多人 / 会签 / 申请字段） ---- */
const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'r:admin', label: '角色：管理员' },
  { value: 'r:engineer', label: '角色：工程师' },
  { value: 'r:fleet_admin', label: '角色：车队管理员' },
];

const flowEd = ref<{ id: number | null; name: string; steps: { mode: 'any' | 'all'; approvers: string[] }[]; fields: any[] }>({
  id: null,
  name: '',
  steps: [],
  fields: [],
});

function openFlowEditor(f: any) {
  const bySeq = new Map<number, { mode: string; approvers: string[] }>();
  for (const n of f.nodes || []) {
    if (!bySeq.has(n.seq)) bySeq.set(n.seq, { mode: n.mode || 'any', approvers: [] });
    const grp = bySeq.get(n.seq)!;
    grp.mode = n.mode || grp.mode;
    grp.approvers.push(n.approverId != null ? `u:${n.approverId}` : `r:${n.approverRole}`);
  }
  const steps: any[] = [];
  for (const [, v] of [...bySeq.entries()].sort((a, b) => a[0] - b[0])) steps.push(v);
  flowEd.value = {
    id: f.id,
    name: f.name,
    steps: steps.length ? steps : [{ mode: 'any', approvers: [''] }],
    fields: (f.fields || []).map((x: any) => ({ ...x })),
  };
}
function addStep() {
  flowEd.value.steps.push({ mode: 'any', approvers: [''] });
}
function delStep(i: number) {
  flowEd.value.steps.splice(i, 1);
}
function moveStep(i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= flowEd.value.steps.length) return;
  const a = flowEd.value.steps.slice();
  [a[i], a[j]] = [a[j], a[i]];
  flowEd.value.steps = a;
}
function addApprover(i: number) {
  flowEd.value.steps[i].approvers.push('');
}
function delApprover(i: number, j: number) {
  flowEd.value.steps[i].approvers.splice(j, 1);
  if (!flowEd.value.steps[i].approvers.length) flowEd.value.steps[i].approvers.push('');
}

async function saveFlow() {
  const f = flowEd.value;
  const steps = f.steps.map((st) => ({
    mode: st.mode,
    approvers: st.approvers.filter((t) => t).map((t) => (t.startsWith('r:') ? { approverRole: t.slice(2) } : { approverId: Number(t.slice(2)) })),
  }));
  if (!steps.length || steps.some((s) => !s.approvers.length)) return ElMessage.warning('每个步骤至少需要一个审批人');
  for (const fd of f.fields) {
    if (!fd.key || !fd.label) return ElMessage.warning('申请字段的「字段名」与「显示名」都不能为空');
  }
  try {
    await approvals.updateFlow(f.id, { name: f.name, fields: f.fields });
    await approvals.setSteps(f.id, steps);
    ElMessage.success('流程已保存');
    loadFlows();
  } catch (e: any) {
    ElMessage.error(e.message || '保存失败');
  }
}

async function newFlow() {
  try {
    const r = await ElMessageBox.prompt('新流程名称', '新建流程', { inputPlaceholder: '如：请假审批' });
    const name = String(r.value || '').trim();
    if (!name) return;
    const code = 'flow_' + Date.now().toString(36);
    const c = await approvals.createFlow({ code, name });
    ElMessage.success('已创建，请配置审批步骤与申请字段');
    await loadFlows();
    openFlowEditor(c);
  } catch (e: any) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  }
}
async function delFlow(f: any) {
  try {
    await ElMessageBox.confirm(`确认删除流程「${f.name}」？`, '提示', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await approvals.deleteFlow(f.id);
    if (flowEd.value.id === f.id) flowEd.value = { id: null, name: '', steps: [], fields: [] };
    ElMessage.success('已删除');
    loadFlows();
  } catch (e: any) {
    ElMessage.error(e.message || '删除失败');
  }
}

const STATUS_LABEL: Record<string, string> = { pending: '待审批', approved: '已通过', rejected: '已驳回', cancelled: '已撤销' };
const STATUS_TYPE: Record<string, string> = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'info' };

onMounted(() => {
  loadFlows();
  loadSubmitMeta();
  refresh();
});
</script>

<template>
  <div v-loading="loading">
    <el-tabs v-model="tab">
      <el-tab-pane label="待我审批" name="todo">
        <el-table :data="todoList" border stripe>
          <el-table-column prop="no" label="单号" width="150" />
          <el-table-column label="申请" min-width="120">
            <template #default="{ row }">{{ KIND_LABEL[row.kind] || row.kind }}</template>
          </el-table-column>
          <el-table-column label="申请对象" min-width="180">
            <template #default="{ row }">{{ targetText(row.payload) }}</template>
          </el-table-column>
          <el-table-column label="变更内容" min-width="200">
            <template #default="{ row }">{{ changeText(row.payload) }}</template>
          </el-table-column>
          <el-table-column prop="requesterName" label="申请人" width="100" />
          <el-table-column label="进度" width="90">
            <template #default="{ row }">第 {{ row.currentSeq }} 步</template>
          </el-table-column>
          <el-table-column label="提交时间" min-width="150">
            <template #default="{ row }">{{ fmt(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{ row }">
              <el-button link type="success" @click="act(row, 'approve')">通过</el-button>
              <el-button link type="danger" @click="act(row, 'reject')">驳回</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="我的申请" name="mine">
        <div style="margin-bottom: 10px">
          <el-button type="primary" @click="openSubmit">发起申请</el-button>
        </div>
        <el-table :data="mineList" border stripe>
          <el-table-column prop="no" label="单号" width="150" />
          <el-table-column label="申请" min-width="120">
            <template #default="{ row }">{{ KIND_LABEL[row.kind] || row.kind }}</template>
          </el-table-column>
          <el-table-column label="申请对象" min-width="180">
            <template #default="{ row }">{{ targetText(row.payload) }}</template>
          </el-table-column>
          <el-table-column label="变更内容" min-width="200">
            <template #default="{ row }">{{ changeText(row.payload) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="STATUS_TYPE[row.status]">{{ STATUS_LABEL[row.status] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="进度" width="80">
            <template #default="{ row }">第 {{ row.currentSeq }} 步</template>
          </el-table-column>
          <el-table-column prop="reason" label="说明" min-width="130" />
          <el-table-column label="提交时间" min-width="150">
            <template #default="{ row }">{{ fmt(row.createdAt) }}</template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane v-if="isAdmin" label="流程配置" name="flows">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="全流程自定义：新建/删除流程、自由编排审批步骤与申请字段；每步可选「任一人通过」或「会签（全部通过）」，审批人可指定账号或按角色。"
          style="margin-bottom: 12px"
        />
        <div style="margin-bottom: 10px">
          <el-button type="primary" @click="newFlow">＋ 新建流程</el-button>
        </div>
        <el-table :data="flows" border stripe style="margin-bottom: 16px">
          <el-table-column prop="name" label="流程名称" min-width="180" />
          <el-table-column prop="code" label="编码" min-width="120" />
          <el-table-column label="步骤" width="80">
            <template #default="{ row }">{{ [...new Set((row.nodes || []).map((n: any) => n.seq))].length }} 步</template>
          </el-table-column>
          <el-table-column label="申请字段" width="100">
            <template #default="{ row }">{{ (row.fields || []).length }} 个</template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'primary' : 'danger'">{{ row.active ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="160" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openFlowEditor(row)">编辑</el-button>
              <el-button link type="danger" @click="delFlow(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="flowEd.id">
          <el-row style="margin-bottom: 10px; align-items: center; gap: 8px">
            <span style="font-weight: 600">编辑：</span>
            <el-input v-model="flowEd.name" style="width: 260px" placeholder="流程名称" />
            <el-button type="primary" @click="saveFlow">保存流程</el-button>
          </el-row>

          <div class="sec-title">申请字段（发起时要填的内容）</div>
          <div class="sec-tip">字段名支持中文；「数据来源」选车辆/组织/供应商/账号后，即使把名字改成中文，审批通过也能自动对上车架号、目标组织等。</div>
          <div v-for="(fd, fi) in flowEd.fields" :key="fi" class="field-row">
            <el-input v-model="fd.key" placeholder="字段名 如 车架号" style="width: 160px" />
            <el-input v-model="fd.label" placeholder="显示名 如 车架号" style="width: 150px" />
            <el-select v-model="fd.type" style="width: 110px">
              <el-option value="select" label="下拉选择" />
              <el-option value="text" label="单行文本" />
              <el-option value="textarea" label="多行文本" />
              <el-option value="number" label="数字" />
              <el-option value="datetime" label="日期时间" />
            </el-select>
            <el-select v-model="fd.source" clearable placeholder="数据来源" style="width: 140px">
              <el-option value="vehicles" label="车辆" />
              <el-option value="organizations" label="组织" />
              <el-option value="suppliers" label="供应商" />
              <el-option value="users" label="账号" />
              <el-option value="active_sessions" label="进行中工单" />
            </el-select>
            <el-checkbox v-model="fd.required">必填</el-checkbox>
            <el-button link type="danger" @click="flowEd.fields.splice(fi, 1)">移除</el-button>
          </div>
          <el-button link type="primary" @click="flowEd.fields.push({ key: '', label: '', type: 'text', source: null, required: false })">
            ＋ 加字段
          </el-button>

          <div class="sec-title">审批步骤</div>
          <div v-for="(st, si) in flowEd.steps" :key="si" class="step-card">
            <div class="step-head">
              <span class="step-no">第 {{ si + 1 }} 步</span>
              <el-radio-group v-model="st.mode" size="small">
                <el-radio-button label="any">任一人通过</el-radio-button>
                <el-radio-button label="all">会签（全部通过）</el-radio-button>
              </el-radio-group>
              <span style="flex: 1"></span>
              <el-button link @click="moveStep(si, -1)">↑</el-button>
              <el-button link @click="moveStep(si, 1)">↓</el-button>
              <el-button link type="danger" @click="delStep(si)">删除步骤</el-button>
            </div>
            <div v-for="(ap, ai) in st.approvers" :key="ai" style="display: flex; gap: 8px; margin: 6px 0 6px 24px">
              <el-select v-model="st.approvers[ai]" filterable placeholder="选择审批人（账号或角色）" style="width: 320px">
                <el-option-group label="按角色">
                  <el-option v-for="o in ROLE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
                </el-option-group>
                <el-option-group label="指定账号">
                  <el-option v-for="u in users" :key="u.id" :label="`${u.name}（${ROLE_LABEL[(u.role || 'admin') as AdminRole]}）`" :value="`u:${u.id}`" />
                </el-option-group>
              </el-select>
              <el-button link type="danger" @click="delApprover(si, ai)">移除</el-button>
            </div>
            <el-button link type="primary" style="margin-left: 24px" @click="addApprover(si)">＋ 加审批人</el-button>
          </div>
          <el-button @click="addStep">＋ 添加步骤</el-button>
        </div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="subShow" title="发起申请" width="540px">
      <el-alert type="info" :closable="false" show-icon title="下拉里只会出现你有权限看到的车辆；有未完结工单的车辆不可调配。" style="margin-bottom: 14px" />
      <el-form label-width="100px">
        <el-form-item label="审批流程">
          <el-select v-model="subForm.flowCode" style="width: 100%">
            <el-option v-for="f in flowOpts" :key="f.code" :label="f.name" :value="f.code" />
          </el-select>
        </el-form-item>
        <template v-for="f in curFields" :key="f.key">
          <el-form-item :label="f.label" :required="!!f.required">
            <el-select v-if="f.type === 'select'" v-model="subForm.values[f.key]" filterable clearable style="width: 100%" :placeholder="`请选择${f.label}`">
              <el-option v-for="o in fieldOpts(f)" :key="o.value" :label="o.label" :value="o.value" :disabled="!!o.disabled" />
            </el-select>
            <el-date-picker v-else-if="f.type === 'datetime'" v-model="subForm.values[f.key]" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm" style="width: 100%" :placeholder="`请选择${f.label}`" />
            <el-input v-else-if="f.type === 'textarea'" v-model="subForm.values[f.key]" type="textarea" :rows="2" :placeholder="`请填写${f.label}`" />
            <el-input v-else v-model="subForm.values[f.key]" :placeholder="`请填写${f.label}`" />
          </el-form-item>
        </template>
        <el-alert v-if="subForm.flowCode === 'org_change'" type="warning" :closable="false" title="车架号与目标账号二选一；目标组织/供应商至少填一项。" />
      </el-form>
      <template #footer>
        <el-button @click="subShow = false">取消</el-button>
        <el-button type="primary" :loading="subSaving" @click="saveSubmit">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.sec-title {
  font-weight: 600;
  margin: 12px 0 6px;
  color: #303133;
}
.sec-tip {
  font-size: 12px;
  color: #909399;
  margin-bottom: 8px;
  line-height: 1.6;
}
.field-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.step-card {
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.step-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.step-no {
  font-weight: 600;
  color: #409eff;
}
</style>
