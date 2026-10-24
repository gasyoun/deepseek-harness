/** `goal` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'phase.active': '进行中的目标',
  'phase.active.disarmed': '已暂停的目标',
  'phase.paused': '已暂停的目标',
  'phase.blocked': '受阻的目标',
  'objective.aria': '目标内容',
  'commandInput.aria': '指令输入',
  'action.save': '保存目标',
  'action.cancel': '取消编辑',
  'action.pause': '暂停目标',
  'action.resume': '恢复目标',
  'action.edit': '编辑目标',
  'action.clear': '清除目标',
  'subgoals.label': '子目标',
  'subgoals.status.open': '未完成',
  'subgoals.status.done': '已完成',
  'subgoals.status.blocked': '受阻',
} satisfies Record<string, string>

/** The goal namespace key union. */
export type GoalKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'phase.active': 'Ongoing Goal',
  'phase.active.disarmed': 'Inactive Goal',
  'phase.paused': 'Paused Goal',
  'phase.blocked': 'Blocked Goal',
  'objective.aria': 'Goal objective',
  'commandInput.aria': 'Command input',
  'action.save': 'Save goal',
  'action.cancel': 'Cancel edit',
  'action.pause': 'Pause goal',
  'action.resume': 'Resume goal',
  'action.edit': 'Edit goal',
  'action.clear': 'Clear goal',
  'subgoals.label': 'Subgoals',
  'subgoals.status.open': 'Open',
  'subgoals.status.done': 'Done',
  'subgoals.status.blocked': 'Blocked',
} satisfies Record<GoalKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'phase.active': '進行中の目標',
  'phase.active.disarmed': '非アクティブな目標',
  'phase.paused': '一時停止中の目標',
  'phase.blocked': 'ブロックされた目標',
  'objective.aria': '目標の目的',
  'commandInput.aria': 'コマンド入力',
  'action.save': '目標を保存',
  'action.cancel': '編集をキャンセル',
  'action.pause': '目標を一時停止',
  'action.resume': '目標を再開',
  'action.edit': '目標を編集',
  'action.clear': '目標をクリア',
  'subgoals.label': 'サブゴール',
  'subgoals.status.open': '未完了',
  'subgoals.status.done': '完了',
  'subgoals.status.blocked': 'ブロック',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'phase.active': 'Meta en curso',
  'phase.active.disarmed': 'Meta inactiva',
  'phase.paused': 'Objetivo en pausa',
  'phase.blocked': 'Meta bloqueada',
  'objective.aria': 'Objetivo de meta',
  'commandInput.aria': 'Entrada de comando',
  'action.save': 'Guardar gol',
  'action.cancel': 'Cancelar edición',
  'action.pause': 'Pausar objetivo',
  'action.resume': 'Reanudar objetivo',
  'action.edit': 'Editar objetivo',
  'action.clear': 'Objetivo claro',
  'subgoals.label': 'Subobjetivos',
  'subgoals.status.open': 'Pendiente',
  'subgoals.status.done': 'Hecho',
  'subgoals.status.blocked': 'Bloqueado',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'phase.active': 'Objectif continu',
  'phase.active.disarmed': 'Objectif inactif',
  'phase.paused': 'Objectif suspendu',
  'phase.blocked': 'Objectif bloqué',
  'objective.aria': 'Objectif du but',
  'commandInput.aria': 'Entrée de commande',
  'action.save': "Sauvegarder l'objectif",
  'action.cancel': 'Annuler la modification',
  'action.pause': "Suspendre l'objectif",
  'action.resume': "Reprendre l'objectif",
  'action.edit': "Modifier l'objectif",
  'action.clear': 'Objectif clair',
  'subgoals.label': 'Sous-objectifs',
  'subgoals.status.open': 'En cours',
  'subgoals.status.done': 'Terminé',
  'subgoals.status.blocked': 'Bloqué',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'phase.active': 'Fortlaufendes Ziel',
  'phase.active.disarmed': 'Inaktives Ziel',
  'phase.paused': 'Pausiertes Ziel',
  'phase.blocked': 'Blockiertes Ziel',
  'objective.aria': 'Zielziel',
  'commandInput.aria': 'Befehlseingabe',
  'action.save': 'Ziel speichern',
  'action.cancel': 'Bearbeitung abbrechen',
  'action.pause': 'Ziel pausieren',
  'action.resume': 'Ziel fortsetzen',
  'action.edit': 'Ziel bearbeiten',
  'action.clear': 'Klares Ziel',
  'subgoals.label': 'Teilziele',
  'subgoals.status.open': 'Offen',
  'subgoals.status.done': 'Erledigt',
  'subgoals.status.blocked': 'Blockiert',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'phase.active': 'Текущая цель',
  'phase.active.disarmed': 'Неактивная цель',
  'phase.paused': 'Приостановленная цель',
  'phase.blocked': 'Заблокированная цель',
  'objective.aria': 'Цель Цель',
  'commandInput.aria': 'Ввод команды',
  'action.save': 'Сохранить цель',
  'action.cancel': 'Отменить редактирование',
  'action.pause': 'Приостановить цель',
  'action.resume': 'Возобновить цель',
  'action.edit': 'Изменить цель',
  'action.clear': 'Четкая цель',
  'subgoals.label': 'Подцели',
  'subgoals.status.open': 'Открыта',
  'subgoals.status.done': 'Готово',
  'subgoals.status.blocked': 'Заблокирована',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'phase.active': 'Meta contínua',
  'phase.active.disarmed': 'Meta inativa',
  'phase.paused': 'Meta pausada',
  'phase.blocked': 'Meta bloqueada',
  'objective.aria': 'Objetivo da meta',
  'commandInput.aria': 'Entrada de comando',
  'action.save': 'Salvar meta',
  'action.cancel': 'Cancelar edição',
  'action.pause': 'Pausar meta',
  'action.resume': 'Retomar meta',
  'action.edit': 'Editar meta',
  'action.clear': 'Objetivo claro',
  'subgoals.label': 'Subobjetivos',
  'subgoals.status.open': 'Pendente',
  'subgoals.status.done': 'Concluído',
  'subgoals.status.blocked': 'Bloqueado',
} satisfies Record<keyof typeof en, string>
