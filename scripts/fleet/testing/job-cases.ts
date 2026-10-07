// Reviewed synthetic scenarios from the per-app workflow suites; no live business data.
import type { DraftFleetApp } from '../runtime/apps.ts';
export interface JobCase { master: string; table: string; noun: string; fk: string; sample: Record<string, unknown>; settings: Record<string, unknown> | null; expected: Record<string, unknown> }
export const JOB_CASES: Record<DraftFleetApp, JobCase> = {
  "asset": {
    "master": "assignees",
    "table": "requests",
    "noun": "request",
    "fk": "reference_id",
    "sample": {
      "item": "Reviewed item",
      "band": "executive",
      "notes": null
    },
    "settings": null,
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "buy": {
    "master": "vendors",
    "table": "orders",
    "noun": "po",
    "fk": "vendor_id",
    "sample": {
      "amount_minor": 12345,
      "currency": "INR",
      "description": null
    },
    "settings": {
      "currency": "INR",
      "review_limit_minor": 10000
    },
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "clear": {
    "master": "subjects",
    "table": "assessments",
    "noun": "assessment",
    "fk": "subject_id",
    "sample": {
      "sanctions": true,
      "pep": false,
      "adverse": false,
      "evidence_reference": "User-supplied evidence record E-1; not independently verified"
    },
    "settings": {
      "case_score": 50,
      "sar_score": 75
    },
    "expected": {
      "score": 60,
      "rating": "medium",
      "case_draft": true,
      "sar_draft": true,
      "assessment_status": "review_only",
      "requires_elevated_approval": false
    }
  },
  "deal": {
    "master": "opportunities",
    "table": "quotes",
    "noun": "quote",
    "fk": "opportunity_id",
    "sample": {
      "list_price_minor": 101,
      "currency": "INR",
      "discount_bps": 5001
    },
    "settings": {
      "currency": "INR",
      "discount_limit_bps": 5000
    },
    "expected": {
      "net_minor": 50,
      "discount_limit_bps": 5000,
      "requires_elevated_approval": true
    }
  },
  "desk": {
    "master": "tickets",
    "table": "refunds",
    "noun": "refund",
    "fk": "ticket_id",
    "sample": {
      "amount_minor": 12345,
      "currency": "INR",
      "reason": null
    },
    "settings": {
      "currency": "INR",
      "review_limit_minor": 10000
    },
    "expected": {
      "review_limit_minor": 10000,
      "requires_elevated_approval": true
    }
  },
  "grant": {
    "master": "requestors",
    "table": "requests",
    "noun": "access",
    "fk": "reference_id",
    "sample": {
      "system": "Reviewed item",
      "level": "admin",
      "notes": null
    },
    "settings": null,
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "guard": {
    "master": "assets",
    "table": "incidents",
    "noun": "response",
    "fk": "reference_id",
    "sample": {
      "summary": "Reviewed item",
      "severity": "critical",
      "notes": null
    },
    "settings": null,
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "hire": {
    "master": "candidates",
    "table": "offers",
    "noun": "offer",
    "fk": "candidate_id",
    "sample": {
      "salary_minor": 12345,
      "currency": "INR",
      "role": null
    },
    "settings": {
      "currency": "INR",
      "review_limit_minor": 10000
    },
    "expected": {
      "review_limit_minor": 10000,
      "requires_elevated_approval": true
    }
  },
  "pay": {
    "master": "payees",
    "table": "payments",
    "noun": "payment",
    "fk": "payee_id",
    "sample": {
      "amount_minor": 12345,
      "currency": "INR",
      "method": "wire",
      "notes": null
    },
    "settings": {
      "currency": "INR",
      "review_limit_minor": 10000
    },
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "post": {
    "master": "channels",
    "table": "posts",
    "noun": "content",
    "fk": "reference_id",
    "sample": {
      "title": "Reviewed item",
      "audience": "regulated",
      "notes": null
    },
    "settings": null,
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "quote": {
    "master": "accounts",
    "table": "quotes",
    "noun": "deal",
    "fk": "account_id",
    "sample": {
      "amount_minor": 12345,
      "currency": "INR",
      "band": "exceptional",
      "notes": null
    },
    "settings": {
      "currency": "INR"
    },
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "reach": {
    "master": "audiences",
    "table": "campaigns",
    "noun": "campaign",
    "fk": "audience_id",
    "sample": {
      "channel": "email",
      "recipients": 51,
      "subject": null,
      "body": "Reviewed content, not a dispatched message"
    },
    "settings": {
      "recipient_limit": 50
    },
    "expected": {
      "recipient_limit": 50,
      "requires_elevated_approval": true
    }
  },
  "renew": {
    "master": "vendors",
    "table": "renewals",
    "noun": "renewal",
    "fk": "vendor_id",
    "sample": {
      "amount_minor": 12345,
      "currency": "INR",
      "term": "multiyear",
      "notes": null
    },
    "settings": {
      "currency": "INR",
      "review_limit_minor": 10000
    },
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "roster": {
    "master": "employees",
    "table": "requests",
    "noun": "leave",
    "fk": "employee_id",
    "sample": {
      "type": "unpaid",
      "half_days": 3,
      "notes": null
    },
    "settings": null,
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "shift": {
    "master": "services",
    "table": "changes",
    "noun": "change",
    "fk": "reference_id",
    "sample": {
      "summary": "Reviewed item",
      "risk": "high",
      "notes": null
    },
    "settings": null,
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "sign": {
    "master": "counterparties",
    "table": "contracts",
    "noun": "contract",
    "fk": "reference_id",
    "sample": {
      "title": "Reviewed item",
      "risk": "high",
      "notes": null
    },
    "settings": null,
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "sync": {
    "master": "datasets",
    "table": "exports",
    "noun": "export",
    "fk": "reference_id",
    "sample": {
      "destination": "Reviewed item",
      "sensitivity": "pii",
      "notes": null
    },
    "settings": null,
    "expected": {
      "requires_elevated_approval": true
    }
  },
  "vet": {
    "master": "suppliers",
    "table": "onboardings",
    "noun": "onboarding",
    "fk": "reference_id",
    "sample": {
      "engagement": "Reviewed item",
      "tier": "high",
      "notes": null
    },
    "settings": null,
    "expected": {
      "requires_elevated_approval": true
    }
  }
};
