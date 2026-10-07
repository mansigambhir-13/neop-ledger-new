-- 024_s9_expand.sql · safe S9 expand bridge.
--
-- V3 no longer gives an app an L3/gateway address: the platform communicates through Matrix and the app-owned
-- database contract. The destructive 024 contraction removes apps.l3_url entirely, but ordinary deploys
-- deliberately stop before 024 until the explicit cutover. Make the legacy column optional in that expand window
-- so a clean install and an upgrade can register V3 apps without inventing a dead endpoint.
--
-- This is metadata-only, preserves every existing value, and is safe to roll out before the 025 cutover.
alter table neos.apps alter column l3_url drop not null;
