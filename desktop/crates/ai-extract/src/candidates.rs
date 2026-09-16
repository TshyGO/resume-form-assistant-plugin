//! 候选申请在本地挑，不把整个档案库送给模型。

/// 一条候选申请。只带模型判断得上的三项，**没有 UUID 之外的任何标识**，
/// 而 UUID 本身也不会进请求（见 [`crate::prompt::build_request`]）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub company: String,
    pub title: String,
    pub stage: String,
}

/// 一次最多送多少条候选。多于这个数说明本地筛选没起作用，与其让模型在几十条里猜，
/// 不如让用户先关联或手选。
pub const MAX_CANDIDATES: usize = 8;

/// 证据已经关联到某条申请时只送那一条；否则把公司名命中的结果去重后截断。
pub fn pick_candidates(
    associated: Option<&Candidate>,
    exact: &[Candidate],
    same_company: &[Candidate],
) -> Vec<Candidate> {
    if let Some(one) = associated {
        return vec![one.clone()];
    }
    let mut picked: Vec<Candidate> = Vec::new();
    for candidate in exact.iter().chain(same_company.iter()) {
        if picked.iter().any(|c| c.id == candidate.id) {
            continue;
        }
        picked.push(candidate.clone());
        if picked.len() >= MAX_CANDIDATES {
            break;
        }
    }
    picked
}
