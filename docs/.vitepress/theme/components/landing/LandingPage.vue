<script setup lang="ts">
/**
 * Landing page composition. Each section is self-contained: it owns its
 * <section class="landing-section" id="..."> root and everything inside.
 * Keep the section ids stable; other pages may link to #install etc.
 */
import LandingAgents from './LandingAgents.vue'
import LandingCommunity from './LandingCommunity.vue'
import LandingDocsMap from './LandingDocsMap.vue'
import LandingHero from './LandingHero.vue'
import LandingInstall from './LandingInstall.vue'
import LandingQuickStart from './LandingQuickStart.vue'
import LandingRouteDemo from './LandingRouteDemo.vue'
import LandingStory from './LandingStory.vue'
import LandingWorkflow from './LandingWorkflow.vue'
</script>

<template>
  <div class="landing">
    <LandingHero />
    <LandingQuickStart />
    <LandingStory />
    <LandingDocsMap />
    <LandingWorkflow />
    <LandingRouteDemo />
    <LandingInstall />
    <LandingAgents />
    <LandingCommunity />
  </div>
</template>
