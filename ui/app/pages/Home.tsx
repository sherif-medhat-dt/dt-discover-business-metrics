import React from "react";
import { Link } from "react-router-dom";
import { useCurrentTheme } from "@dynatrace/strato-components/core";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Surface } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph, Strong, Text } from "@dynatrace/strato-components/typography";
import Colors from "@dynatrace/strato-design-tokens/colors";

const FeatureCard = ({
  to,
  title,
  description,
  badge,
  badgeColor,
}: {
  to: string;
  title: string;
  description: string;
  badge?: string;
  badgeColor?: string;
}) => (
  <Link to={to} style={{ textDecoration: "none" }}>
    <Surface
      style={{
        width: 280,
        cursor: "pointer",
        transition: "box-shadow 0.15s",
      }}
    >
      <Flex flexDirection="column" gap={8} padding={24}>
        {badge && (
          <Text
            style={{
              fontSize: "11px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: badgeColor ?? Colors.Text.Primary.Default,
            }}
          >
            {badge}
          </Text>
        )}
        <Strong style={{ fontSize: "18px" }}>{title}</Strong>
        <Paragraph style={{ color: Colors.Text.Neutral.Default, fontSize: "14px" }}>
          {description}
        </Paragraph>
      </Flex>
    </Surface>
  </Link>
);

export const Home = () => {
  const theme = useCurrentTheme();
  return (
    <Flex flexDirection="column" alignItems="center" padding={48} gap={32}>
      <img
        src="./assets/Dynatrace_Logo.svg"
        alt="Dynatrace Logo"
        width={80}
        height={80}
      />

      <Flex flexDirection="column" alignItems="center" gap={8}>
        <Heading level={1}>Business Metrics Discovery</Heading>
        <Paragraph
          style={{ color: Colors.Text.Neutral.Default, textAlign: "center", maxWidth: 560, fontSize: "16px" }}
        >
          Automatically discover all potential business metric sources in your application traces —
          payment amounts, user identifiers, transaction references, loyalty status, and more.
        </Paragraph>
      </Flex>

      <Flex gap={24} flexWrap="wrap" justifyContent="center">
        <FeatureCard
          to="/discovery"
          title="Discover Business Metrics"
          description="Scan services, HTTP endpoints, and method spans to find where your business data lives. Get step-by-step Request Attribute configuration instructions."
          badge="★ Start Here"
          badgeColor={Colors.Text.Success.Default}
        />
        <FeatureCard
          to="/wizard"
          title="Journey Dashboard Wizard"
          description="Describe a 1–4-step user journey by endpoint name and generate a Dynatrace dashboard with IT Issues, Security, a Business KPI placeholder, and your business metric tiles — ready to import."
          badge="New"
          badgeColor={Colors.Text.Primary.Default}
        />
      </Flex>

      <Flex flexDirection="column" alignItems="center" gap={12} style={{ maxWidth: 560 }}>
        <Strong>What this app discovers</Strong>
        <Flex gap={8} flexWrap="wrap" justifyContent="center">
          {[
            "💰 Transaction amounts",
            "👤 User identifiers",
            "📦 Order references",
            "🏷️ Product SKUs",
            "🎯 Loyalty tiers",
            "💳 Payment methods",
            "🌍 Currency codes",
            "📋 Confirmation codes",
          ].map((item) => (
            <Surface key={item}>
              <Flex padding={8}>
                <Text style={{ fontSize: "13px" }}>{item}</Text>
              </Flex>
            </Surface>
          ))}
        </Flex>
      </Flex>
    </Flex>
  );
};
