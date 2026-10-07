// Synthetic domain inputs, never production data or a business-policy approval.
export const fixture={"id":"post","master":"channels","table":"posts","noun":"content","fk":"reference_id","sample":{"title":"Reviewed item","audience":"regulated","notes":null},"settings":null,"expected":{"requires_elevated_approval":true},"invalid":{"audience":"invalid"},"mutation":{"title":"Changed item"}};
