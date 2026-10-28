const Property = require("../../models/Property");

/**
 * Property Matcher
 *
 * IMPORTANT PRIORITY:
 * 1. Current customer message
 * 2. Explicit project/city mentioned in current message
 * 3. Current requirements
 * 4. Old conversation requirements
 *
 * Supported:
 * - Complete property/project list
 * - City-wise property list
 * - Specific project lookup
 * - Other project lookup
 * - Other city lookup
 * - Budget matching
 * - BHK matching
 * - Property type matching
 * - Location matching
 * - Amenities matching
 * - Current message overriding old context
 */

async function matchProperties(
  {
    query = "",
    city,
    location,
    projectName,
    budgetMin,
    budgetMax,
    bhk,
    propertyType,
    amenities = [],
  },
  limit = 5,
) {
  const activeFilter = {
    isActive: true,
    // Booked / sold units (set in Properties → Excel mode) are never suggested.
    availability: { $nin: ["booked", "sold"] },
  };

  // ---------------------------------------------------------
  // 1. LOAD COMPLETE ACTIVE INVENTORY
  // ---------------------------------------------------------

  const allProperties = await Property.find(activeFilter).limit(1000).lean();

  if (!allProperties.length) {
    return [];
  }

  const normalizedQuery = normalize(query);

  // ---------------------------------------------------------
  // 2. CURRENT MESSAGE DETECTION
  // ---------------------------------------------------------

  const detectedProject = findProjectMentioned(allProperties, normalizedQuery);

  const detectedCity = findCityMentioned(allProperties, normalizedQuery);

  const askingOtherCity = isOtherCityQuestion(normalizedQuery);

  const askingOtherProperty = isOtherPropertyQuestion(normalizedQuery);

  const askingCompleteInventory = isCompleteInventoryQuestion(normalizedQuery);

  const askingCityInventory = isCityInventoryQuestion(normalizedQuery);

  const askingAllProjects = isAllProjectListQuestion(normalizedQuery);

  // ---------------------------------------------------------
  // 3. CURRENT MESSAGE HAS HIGHEST PRIORITY
  // ---------------------------------------------------------

  let effectiveCity = city || null;

  let effectiveProjectName = projectName || null;

  if (detectedCity) {
    effectiveCity = detectedCity;
  }

  if (detectedProject?.projectName) {
    effectiveProjectName = detectedProject.projectName;
  }

  // ---------------------------------------------------------
  // 4. "OTHER CITY" MEANS IGNORE OLD CITY
  // ---------------------------------------------------------

  if (askingOtherCity) {
    effectiveCity = null;
    effectiveProjectName = null;
  }

  // ---------------------------------------------------------
  // 5. SPECIFIC PROJECT QUESTION
  //
  // Example:
  // "Ivory hai?"
  // "Ivory ka price kya hai?"
  // "Jade County ki details batao"
  // ---------------------------------------------------------

  if (detectedProject?.projectName) {
    const projectProperties = allProperties.filter((property) =>
      sameProject(property.projectName, detectedProject.projectName),
    );

    if (projectProperties.length) {
      return projectProperties;
    }
  }

  // ---------------------------------------------------------
  // 6. COMPLETE INVENTORY QUESTION
  //
  // Example:
  // "tumhare paas kitni properties hain?"
  // "puri list do"
  // "kaun kaun si properties hain?"
  //
  // IMPORTANT:
  // Do NOT apply limit = 5 here.
  // Return every unique project.
  // ---------------------------------------------------------

  if (askingCompleteInventory || askingAllProjects) {
    return getUniqueProjects(allProperties);
  }

  // ---------------------------------------------------------
  // 7. EXPLICIT CITY QUESTION
  //
  // Example:
  // "Noida mein kya properties hain?"
  // "Kanpur mein kya hai?"
  //
  // Current city overrides old city.
  // ---------------------------------------------------------

  if (detectedCity) {
    const cityProperties = allProperties.filter((property) =>
      sameCity(property.city, detectedCity),
    );

    if (askingCityInventory) {
      return getUniqueProjects(cityProperties);
    }

    // If user asks a normal question about this city,
    // use only properties from this city.
    return getMatchedProperties(
      cityProperties,
      {
        query: normalizedQuery,
        location,
        budgetMin,
        budgetMax,
        bhk,
        propertyType,
        amenities,
      },
      limit,
    );
  }

  // ---------------------------------------------------------
  // 8. OTHER PROPERTY / OTHER PROJECT
  //
  // Example:
  // "Sunflower ke alawa aur kya hai?"
  //
  // If a project was mentioned, exclude that project.
  // ---------------------------------------------------------

  if (askingOtherProperty && detectedProject?.projectName) {
    let otherProperties = allProperties.filter(
      (property) =>
        !sameProject(property.projectName, detectedProject.projectName),
    );

    // If there is an old/current city requirement,
    // respect it unless user explicitly asks another city.
    if (effectiveCity) {
      const cityFiltered = otherProperties.filter((property) =>
        sameCity(property.city, effectiveCity),
      );

      if (cityFiltered.length) {
        otherProperties = cityFiltered;
      }
    }

    return getUniqueProjects(otherProperties);
  }

  // ---------------------------------------------------------
  // 9. OTHER CITY QUESTION
  //
  // Example:
  // "koi aur city mein property hai?"
  // "Noida ke alawa kisi aur city mein kya hai?"
  //
  // Do NOT use old city filter.
  // ---------------------------------------------------------

  if (askingOtherCity) {
    let otherCityProperties = allProperties;

    // If old city exists, remove it.
    if (city) {
      otherCityProperties = allProperties.filter(
        (property) => !sameCity(property.city, city),
      );
    }

    return getUniqueProjects(otherCityProperties);
  }

  // ---------------------------------------------------------
  // 10. PROJECT NAME FROM OLD REQUIREMENTS
  //
  // Current message did not contain a project,
  // but conversation requirements may have one.
  // ---------------------------------------------------------

  if (effectiveProjectName) {
    const requirementProjectProperties = allProperties.filter((property) =>
      sameProject(property.projectName, effectiveProjectName),
    );

    if (requirementProjectProperties.length) {
      return requirementProjectProperties;
    }
  }

  // ---------------------------------------------------------
  // 11. CITY FROM OLD REQUIREMENTS
  //
  // Only use old city if current message did not mention
  // another city/project.
  // ---------------------------------------------------------

  let candidates = allProperties;

  if (effectiveCity) {
    const cityCandidates = allProperties.filter((property) =>
      sameCity(property.city, effectiveCity),
    );

    if (cityCandidates.length) {
      candidates = cityCandidates;
    }
  }

  // ---------------------------------------------------------
  // 12. NORMAL REQUIREMENT MATCHING
  // ---------------------------------------------------------

  return getMatchedProperties(
    candidates,
    {
      query: normalizedQuery,
      location,
      budgetMin,
      budgetMax,
      bhk,
      propertyType,
      amenities,
    },
    limit,
  );
}

/**
 * ---------------------------------------------------------
 * GET MATCHED PROPERTIES
 * ---------------------------------------------------------
 *
 * Used for normal recommendation questions.
 *
 * Example:
 * - 2 BHK
 * - under 80 lakh
 * - apartment
 * - near metro
 * - specific location
 */
function getMatchedProperties(properties, requirements, limit = 5) {
  if (!properties.length) {
    return [];
  }

  const scored = properties.map((property) => ({
    property,
    score: scoreMatch(property, requirements),
  }));

  scored.sort((a, b) => b.score - a.score);

  const positive = scored.filter((item) => item.score > 0);

  const pool = positive.length > 0 ? positive : scored;

  return pool.slice(0, limit).map((item) => item.property);
}

/**
 * ---------------------------------------------------------
 * SCORE PROPERTY
 * ---------------------------------------------------------
 */
function scoreMatch(
  property,
  { query, location, budgetMin, budgetMax, bhk, propertyType, amenities = [] },
) {
  let score = 1;

  // -------------------------------------------------------
  // PROJECT NAME
  // -------------------------------------------------------

  if (
    query &&
    property.projectName &&
    containsText(query, property.projectName)
  ) {
    score += 50;
  }

  // -------------------------------------------------------
  // BUILDER
  // -------------------------------------------------------

  if (
    query &&
    property.builderName &&
    containsText(query, property.builderName)
  ) {
    score += 15;
  }

  // -------------------------------------------------------
  // PROPERTY TYPE
  // -------------------------------------------------------

  if (propertyType && property.propertyType) {
    const wantedType = normalize(propertyType);

    const actualType = normalize(property.propertyType);

    if (actualType.includes(wantedType) || wantedType.includes(actualType)) {
      score += 10;
    }
  }

  // -------------------------------------------------------
  // BHK
  // -------------------------------------------------------

  if (bhk != null && property.bhk != null) {
    const requestedBhk = normalizeBhk(bhk);

    const propertyBhk = normalizeBhk(property.bhk);

    if (requestedBhk && propertyBhk && requestedBhk === propertyBhk) {
      score += 10;
    }
  }

  // -------------------------------------------------------
  // BUDGET
  // -------------------------------------------------------

  if (budgetMin != null || budgetMax != null) {
    const buyerMin = toNumberOrNull(budgetMin) ?? 0;

    const buyerMax = toNumberOrNull(budgetMax) ?? Number.MAX_SAFE_INTEGER;

    const propertyMin = toNumberOrNull(property.budgetMin) ?? 0;

    const propertyMax =
      toNumberOrNull(property.budgetMax) ?? Number.MAX_SAFE_INTEGER;

    const overlaps = propertyMin <= buyerMax && propertyMax >= buyerMin;

    if (overlaps) {
      score += 10;
    } else {
      const gap =
        propertyMin > buyerMax
          ? propertyMin - buyerMax
          : buyerMin - propertyMax;

      const referencePoint = buyerMax || buyerMin || propertyMax || 1;

      const gapRatio = gap / referencePoint;

      if (gapRatio <= 0.2) {
        score += 2;
      } else {
        score -= 5;
      }
    }
  }

  // -------------------------------------------------------
  // LOCATION
  // -------------------------------------------------------

  if (location && property.location) {
    const wantedLocation = normalize(location);

    const actualLocation = normalize(property.location);

    if (
      actualLocation.includes(wantedLocation) ||
      wantedLocation.includes(actualLocation)
    ) {
      score += 10;
    }
  }

  // -------------------------------------------------------
  // CITY
  // -------------------------------------------------------

  if (property.city && query) {
    if (containsText(query, property.city)) {
      score += 10;
    }
  }

  // -------------------------------------------------------
  // AMENITIES
  // -------------------------------------------------------

  if (
    Array.isArray(amenities) &&
    amenities.length &&
    Array.isArray(property.amenities)
  ) {
    const propertyAmenities = property.amenities.map((amenity) =>
      normalize(amenity),
    );

    for (const amenity of amenities) {
      const wantedAmenity = normalize(amenity);

      if (
        propertyAmenities.some(
          (actualAmenity) =>
            actualAmenity.includes(wantedAmenity) ||
            wantedAmenity.includes(actualAmenity),
        )
      ) {
        score += 5;
      }
    }
  }

  return score;
}

/**
 * ---------------------------------------------------------
 * FIND PROJECT MENTIONED IN CURRENT MESSAGE
 * ---------------------------------------------------------
 *
 * Project names are taken directly from DB.
 * AI does not invent project names.
 */
function findProjectMentioned(properties, query) {
  if (!query) {
    return null;
  }

  const uniqueProjects = [
    ...new Set(
      properties.map((property) => property.projectName).filter(Boolean),
    ),
  ];

  // Longest project name first.
  // Example:
  // "The Sunflower Heights"
  // before
  // "The Sunflower"
  uniqueProjects.sort((a, b) => String(b).length - String(a).length);

  const found = uniqueProjects.find((project) => containsText(query, project));

  return found
    ? {
        projectName: found,
      }
    : null;
}

/**
 * ---------------------------------------------------------
 * FIND CITY MENTIONED IN CURRENT MESSAGE
 * ---------------------------------------------------------
 */
function findCityMentioned(properties, query) {
  if (!query) {
    return null;
  }

  const cities = [
    ...new Set(properties.map((property) => property.city).filter(Boolean)),
  ];

  cities.sort((a, b) => String(b).length - String(a).length);

  return cities.find((city) => containsText(query, city)) || null;
}

/**
 * ---------------------------------------------------------
 * GET UNIQUE PROJECTS
 * ---------------------------------------------------------
 *
 * One representative property per project.
 *
 * IMPORTANT:
 * No default limit of 5.
 *
 * Used when user asks for:
 * - complete list
 * - city-wise projects
 * - all projects
 * - other projects
 */
function getUniqueProjects(properties) {
  const seen = new Set();

  const result = [];

  for (const property of properties) {
    const projectKey = normalize(property.projectName || "");

    // If a property does not have a project
    // name, don't accidentally group all
    // unnamed properties together.
    if (!projectKey) {
      result.push(property);
      continue;
    }

    if (seen.has(projectKey)) {
      continue;
    }

    seen.add(projectKey);

    result.push(property);
  }

  return result;
}

/**
 * ---------------------------------------------------------
 * COMPLETE INVENTORY QUESTION
 * ---------------------------------------------------------
 *
 * Examples:
 *
 * "tumhare paas kitni properties hain?"
 * "aapke paas kya kya hai?"
 * "puri list do"
 * "complete list"
 * "saari properties batao"
 * "kaun kaun si properties hain?"
 */
function isCompleteInventoryQuestion(query) {
  if (!query) {
    return false;
  }

  return (
    // Count
    /\bkitni\s+(property|properties)\b/i.test(query) ||
    /\bkitne\s+(property|properties)\b/i.test(query) ||
    // Full list
    /\b(puri|poori|complete|full|saari|sari)\s+(list|property|properties|projects)\b/i.test(
      query,
    ) ||
    // What do you have?
    /\b(aapke paas|tumhare paas|apke paas)\b.*\b(kya|kaun|kon|kitni|kitne)\b.*\b(property|properties|project|projects)\b/i.test(
      query,
    ) ||
    // Which properties?
    /\b(kaun|kon|kaunse|konse|kaun\s+kaun|kon\s+kon)\b.*\b(property|properties|project|projects)\b/i.test(
      query,
    ) ||
    // Available inventory
    /\b(available|inventory)\b.*\b(property|properties|project|projects)\b/i.test(
      query,
    ) ||
    /\b(property|properties|project|projects)\b.*\b(available|hain|hai)\b/i.test(
      query,
    ) ||
    // English
    /\bwhat\s+(properties|projects)\s+do\s+you\s+have\b/i.test(query) ||
    /\bwhich\s+(properties|projects)\s+do\s+you\s+have\b/i.test(query)
  );
}

/**
 * ---------------------------------------------------------
 * CITY INVENTORY QUESTION
 * ---------------------------------------------------------
 *
 * Examples:
 *
 * "Noida mein kya properties hain?"
 * "Noida me kya kya hai?"
 * "Kanpur ki saari properties"
 * "Noida ke projects batao"
 */
function isCityInventoryQuestion(query) {
  if (!query) {
    return false;
  }

  const hasPropertyWord = /\b(property|properties|project|projects)\b/i.test(
    query,
  );

  const hasListWord =
    /\b(kaun|kon|kya|kya\s+kya|saari|sari|puri|poori|complete|all|which|what)\b/i.test(
      query,
    );

  const hasAvailabilityWord =
    /\b(available|hain|hai|batao|dikhao|list)\b/i.test(query);

  return hasPropertyWord && (hasListWord || hasAvailabilityWord);
}

/**
 * ---------------------------------------------------------
 * ALL PROJECT LIST QUESTION
 * ---------------------------------------------------------
 */
function isAllProjectListQuestion(query) {
  if (!query) {
    return false;
  }

  return (
    /\b(aapke paas|tumhare paas|apke paas)\b.*\b(project|projects|property|properties)\b/i.test(
      query,
    ) && /\b(kaun|kon|kya|kitni|kitne|available|hain|hai)\b/i.test(query)
  );
}

/**
 * ---------------------------------------------------------
 * OTHER CITY QUESTION
 * ---------------------------------------------------------
 *
 * Examples:
 * - "koi aur city mein hai?"
 * - "kisi aur city mein?"
 * - "dusri city mein property?"
 * - "Noida ke alawa aur city?"
 */
function isOtherCityQuestion(query) {
  if (!query) {
    return false;
  }

  return (
    /\b(koi|kisi|kuch|another|other|different|dusri|dusre|doosri|doosre|aur)\b.*\b(city|cities|shehar)\b/i.test(
      query,
    ) ||
    /\b(aur|another|other|different)\s+(city|cities|shehar)\b/i.test(query) ||
    /\b(city|cities|shehar)\b.*\b(aur|dusri|doosri|other|another)\b/i.test(
      query,
    )
  );
}

/**
 * ---------------------------------------------------------
 * OTHER PROPERTY / OTHER PROJECT QUESTION
 * ---------------------------------------------------------
 *
 * Examples:
 * - "Sunflower ke alawa kya hai?"
 * - "aur koi property?"
 * - "another project?"
 */
function isOtherPropertyQuestion(query) {
  if (!query) {
    return false;
  }

  return (
    /\b(ke alawa|ke ilawa|apart from|besides|other than)\b/i.test(query) ||
    /\b(koi|kuch|another|other|aur|dusra|doosra)\b.*\b(property|properties|project|projects)\b/i.test(
      query,
    ) ||
    /\b(property|properties|project|projects)\b.*\b(aur|other|another)\b/i.test(
      query,
    )
  );
}

/**
 * ---------------------------------------------------------
 * SAME PROJECT
 * ---------------------------------------------------------
 */
function sameProject(a, b) {
  if (!a || !b) {
    return false;
  }

  return normalize(a) === normalize(b);
}

/**
 * ---------------------------------------------------------
 * SAME CITY
 * ---------------------------------------------------------
 */
function sameCity(a, b) {
  if (!a || !b) {
    return false;
  }

  return normalize(a) === normalize(b);
}

/**
 * ---------------------------------------------------------
 * CONTAINS TEXT
 * ---------------------------------------------------------
 */
function containsText(text, value) {
  if (!text || !value) {
    return false;
  }

  return normalize(text).includes(normalize(value));
}

/**
 * ---------------------------------------------------------
 * NORMALIZE TEXT
 * ---------------------------------------------------------
 */
function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * ---------------------------------------------------------
 * NORMALIZE BHK
 * ---------------------------------------------------------
 *
 * Supports:
 * - 2
 * - 2 BHK
 * - 2bhk
 * - "2 BHK apartment"
 */
function normalizeBhk(value) {
  const match = String(value || "").match(/\d+/);

  return match ? match[0] : "";
}

/**
 * ---------------------------------------------------------
 * NUMBER NORMALIZER
 * ---------------------------------------------------------
 */
function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const cleaned = String(value).replace(/,/g, "").replace(/[₹$]/g, "").trim();

  const number = Number(cleaned);

  return Number.isFinite(number) ? number : null;
}

module.exports = {
  matchProperties,
};
