-- 007_trace.sql · the W3C traceparent a task started under (R13), so later
-- hops (delivery retries, approvals, execution) continue the same trace.
alter table neos.tasks add column trace_parent text;
