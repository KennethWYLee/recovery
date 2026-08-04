export type ObservabilityRoleFocus = {
  title: string;
  description: string;
  verificationQuestion: string;
};

export function observabilityRoleFocus(role: string): ObservabilityRoleFocus {
  if (role === "admin" || role === "commander") {
    return {
      title: "先確認影響是否擴大",
      description: "從錯誤率與主要路徑判斷是否需要宣告或升級事件，再指派後續行動。",
      verificationQuestion: "錯誤是否集中在同一項服務、路徑或版本？",
    };
  }
  if (role === "responder") {
    return {
      title: "先定位異常開始的位置",
      description: "比較請求量、延遲與問題代碼，再用request ID核對同一筆失敗。",
      verificationQuestion: "哪一段時間、哪個路徑最先出現異常？",
    };
  }
  if (role === "auditor") {
    return {
      title: "先核對異常與操作是否可追查",
      description: "確認錯誤具有request ID、版本與明確結果，再到稽核紀錄交叉查核。",
      verificationQuestion: "這筆錯誤能否連回當時的版本與後續處理？",
    };
  }
  return {
    title: "先理解目前服務狀況",
    description: "觀察錯誤、延遲與主要受影響路徑；唯讀角色不會改變任何營運資料。",
    verificationQuestion: "目前主要異常是流量、錯誤，還是回應變慢？",
  };
}
