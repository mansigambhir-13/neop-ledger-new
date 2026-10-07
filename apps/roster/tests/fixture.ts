// Synthetic domain inputs, never production data or a business-policy approval.
export const fixture={"id":"roster","master":"employees","table":"requests","noun":"leave","fk":"employee_id","sample":{"type":"unpaid","half_days":3,"notes":null},"settings":null,"expected":{"requires_elevated_approval":true},"invalid":{"half_days":1.5},"mutation":{"half_days":4}};
