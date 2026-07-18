/**
 * shared/i18n/dictionaries.ts — ko (default) and en dictionaries for every
 * hardcoded UI-chrome string in the dashboard (headers, badges, empty
 * states, tooltips, legend copy). Data values that come from disk (goal
 * titles, dialogue excerpts, project/session names, phase names,
 * timestamps) are never looked up here — those render as-is, untranslated.
 */

export type Lang = 'ko' | 'en'

export type TranslateParams = Record<string, string | number>

type DictEntry = string | ((params: TranslateParams) => string)
type Dictionary = Record<string, DictEntry>

const en: Dictionary = {
  'header.title': '🐈 cat-harness — office scene',

  'floorList.header': 'FLOORS',
  'floorList.noProjects': 'no registered projects',

  'floor.dismissTooltip': 'Close floor',
  'floor.dismissConfirm': ({ name }) => `Close "${name}"'s floor?`,
  'floor.dismissError': ({ name, reason }) => `Couldn't close "${name}"'s floor (${reason}). Is the status server running?`,
  'common.dismiss': 'Dismiss',

  'connection.connected': 'connected',
  'connection.reconnecting': 'reconnecting…',
  'connection.connecting': 'connecting…',

  'legend.button': 'legend',
  'legend.title': 'office scene',
  'legend.item.oneFloor': 'one floor per registered project',
  'legend.item.lit': 'lit windows = working',
  'legend.item.leader': '👑 leader cat = the orchestrator (walks between desks to deliver)',
  'legend.item.workers': 'cat at a desk = an agent (planner · architect · critic · executor)',
  'legend.item.typing': 'typing cat = working right now',
  'legend.item.sleeping': 'sleeping cat (Zzz) = waiting',
  'legend.item.bubble': 'speech bubble = the current conversation in progress (leader ↔ agent)',

  'language.toggle.ko': 'KO',
  'language.toggle.en': 'EN',

  'office.title': ({ count }) => `cat-harness tycoon — ${count} floor${count === 1 ? '' : 's'}`,
  'office.noProjects': 'No registered projects yet — the building has no floors.',

  'floor.label': ({ n }) => `Floor ${n}`,
  'floor.noActiveCats': 'no active cats',
  'room.toy': 'toy',

  'status.lit': 'lit',
  'status.dormant': 'dormant',

  'cat.busy': 'busy',
  'cat.idle': 'idle',
  'cat.resting': 'resting',

  'sidePanel.emptyPrompt': 'Click a floor or a cat to inspect it.',
  'sidePanel.projectLabel': 'project',
  'sidePanel.closeAria': 'close panel',
  'sidePanel.noSessions': 'No sessions recorded yet for this project.',
  'sidePanel.sessionLabel': ({ id }) => `session ${id}`,
  'sidePanel.phases': 'phases',
  'sidePanel.noActiveSkills': 'none active',
  'sidePanel.goals': 'goals',
  'sidePanel.noGoals': 'no goals',
  'sidePanel.receipts': 'receipts',
  'sidePanel.noLedger': 'no ledger entries',
  'sidePanel.dialogueTimeline': 'dialogue timeline',
  'sidePanel.noDialogue': 'no dialogue captured',

  'sidePanel.goalDetail.back': '← back to all',
  'sidePanel.goalDetail.eventsTitle': 'events in this goal',
  'sidePanel.goalDetail.noEvents': 'no recorded events for this goal',
  'sidePanel.goalDetail.dialogueTitle': 'dialogue in this window',
  'sidePanel.goalDetail.approximateNote': 'approximate (by time) — dialogue isn’t tagged per goal',
  'sidePanel.goalDetail.noDialogue': 'no dialogue in this time window',
  'sidePanel.goalDetail.noWindow': 'no start time recorded — can’t estimate this goal’s dialogue window',

  // The dispatcher's own identity is never captured (only the dispatched
  // subagent_type is) — so it always renders as this generic label, never a
  // made-up name. See shared/lib/agentLabel.ts's `whoToWhomLabel`.
  'dialogue.leader': 'Lead',

  'goalStatus.complete': 'complete',
  'goalStatus.active': 'active',
  'goalStatus.pending': 'pending',
  'goalStatus.cancelled': 'cancelled',
}

const ko: Dictionary = {
  'header.title': '🐈 cat-harness — 오피스 화면',

  'floorList.header': '층',
  'floorList.noProjects': '등록된 프로젝트 없음',

  'floor.dismissTooltip': '폐업 처리',
  'floor.dismissConfirm': ({ name }) => `"${name}" 층을 폐업 처리할까요?`,
  'floor.dismissError': ({ name, reason }) => `"${name}" 층 폐업 실패 (${reason}). 상태 서버가 실행 중인지 확인하세요.`,
  'common.dismiss': '닫기',

  'connection.connected': '연결됨',
  'connection.reconnecting': '재연결 중…',
  'connection.connecting': '연결 중…',

  'legend.button': '범례',
  'legend.title': '오피스 화면',
  'legend.item.oneFloor': '프로젝트마다 한 개 층',
  'legend.item.lit': '불 켜진 창문 = 작업 중',
  'legend.item.leader': '👑 리더 고양이 = 오케스트레이터(책상 사이를 다니며 전달)',
  'legend.item.workers': '책상에 앉은 고양이 = 에이전트(planner·architect·critic·executor)',
  'legend.item.typing': '타자 치는 고양이 = 지금 작업 중',
  'legend.item.sleeping': '자는 고양이(Zzz) = 대기 중',
  'legend.item.bubble': '말풍선 = 지금 진행 중인 대화(리더 ↔ 에이전트)',

  'language.toggle.ko': 'KO',
  'language.toggle.en': 'EN',

  'office.title': ({ count }) => `cat-harness tycoon — ${count}개 층`,
  'office.noProjects': '등록된 프로젝트가 없습니다 — 건물에 층이 없습니다.',

  'floor.label': ({ n }) => `${n}층`,
  'floor.noActiveCats': '활동 중인 고양이 없음',
  'room.toy': '장난감',

  'status.lit': '작업 중',
  'status.dormant': '멈춤',

  'cat.busy': '작업 중',
  'cat.idle': '대기 중',
  'cat.resting': '쉬는 중',

  'sidePanel.emptyPrompt': '층이나 고양이를 클릭해 자세히 보세요.',
  'sidePanel.projectLabel': '프로젝트',
  'sidePanel.closeAria': '패널 닫기',
  'sidePanel.noSessions': '이 프로젝트에 기록된 세션이 없습니다.',
  'sidePanel.sessionLabel': ({ id }) => `세션 ${id}`,
  'sidePanel.phases': '단계',
  'sidePanel.noActiveSkills': '진행 중인 것 없음',
  'sidePanel.goals': '목표',
  'sidePanel.noGoals': '목표 없음',
  'sidePanel.receipts': '기록',
  'sidePanel.noLedger': '기록 없음',
  'sidePanel.dialogueTimeline': '대화 타임라인',
  'sidePanel.noDialogue': '기록된 대화 없음',

  'sidePanel.goalDetail.back': '← 전체 보기',
  'sidePanel.goalDetail.eventsTitle': '이 목표에서 있었던 일',
  'sidePanel.goalDetail.noEvents': '이 목표에 기록된 사건이 없습니다',
  'sidePanel.goalDetail.dialogueTitle': '이 시간대의 대화',
  'sidePanel.goalDetail.approximateNote': '시간 기준 추정 — 대화는 목표별로 태그되지 않습니다',
  'sidePanel.goalDetail.noDialogue': '이 시간대에 대화가 없습니다',
  'sidePanel.goalDetail.noWindow': '시작 시각 정보가 없어 이 목표의 대화를 추정할 수 없습니다',

  'dialogue.leader': '리더',

  'goalStatus.complete': '완료',
  'goalStatus.active': '진행 중',
  'goalStatus.pending': '대기 중',
  'goalStatus.cancelled': '취소됨',
}

export const dictionaries: Record<Lang, Dictionary> = { en, ko }

/**
 * Resolves `key` in `lang`, falling back to English, then to the raw key
 * itself if nothing matches (which also makes "is this key translated?"
 * checks trivial: `t(key) === key` means no entry exists).
 */
export function translate(lang: Lang, key: string, params?: TranslateParams): string {
  const entry = dictionaries[lang][key] ?? dictionaries.en[key]
  if (entry === undefined) return key
  return typeof entry === 'function' ? entry(params ?? {}) : entry
}
