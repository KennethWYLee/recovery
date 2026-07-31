@g2 @acceptance
Feature: Core reliability controls
  The incident operations domain must reject unsafe states even when the
  surrounding interface or automation submits them.

  Scenario: A responder cannot resolve an incident
    Given the organization role is "responder"
    And the active incident assignment is "responder"
    And the incident status is "monitoring"
    When the actor attempts to transition the incident to "resolved"
    Then the incident transition is rejected

  Scenario: An assigned commander can resolve a monitored incident
    Given the organization role is "commander"
    And the active incident assignment is "incident_commander"
    And the incident status is "monitoring"
    When the actor attempts to transition the incident to "resolved"
    Then the incident transition is allowed

  Scenario: An observer cannot be assigned operational response duties
    Given the organization role is "observer"
    When the actor is considered for the incident assignment "responder"
    Then the incident assignment is rejected

  Scenario: Completed work rejects insecure evidence
    Given a completed task cites "http://evidence.example.invalid/run/42"
    When the task evidence is validated
    Then the task evidence is rejected

  Scenario: Completed work accepts durable HTTPS evidence
    Given a completed task cites "https://evidence.example.invalid/run/42"
    When the task evidence is validated
    Then the task evidence is accepted

  Scenario: A deprecated service cannot receive a new incident
    Given the service lifecycle status is "deprecated"
    When new incident eligibility is evaluated
    Then the service is not eligible for a new incident

  Scenario: The open queue excludes closed and cancelled incidents
    Given the incident list contains "declared,monitoring,resolved,closed,cancelled"
    When the incident list is filtered by "open"
    Then the filtered incident list is "declared,monitoring,resolved"

  Scenario: Only an explicit final marker removes the next-update requirement
    Given the incident communication is "[FINAL] Monitoring has ended."
    When final communication status is evaluated
    Then the communication is treated as final

