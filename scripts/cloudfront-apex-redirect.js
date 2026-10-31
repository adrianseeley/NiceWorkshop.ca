// CloudFront Functions, JavaScript runtime 2.0; associate with viewer-request.
// Keep this function dedicated to the niceworkshop.ca redirect distribution.
// Query fields are serialized as supplied, following AWS's normalization example:
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/example_cloudfront_functions_normalize_query_string_parameters_section.html
function handler(event) {
  var request = event.request;
  var query = request.querystring;
  var parts = [];

  Object.keys(query).forEach(function (name) {
    var parameter = query[name];
    // multiValue already includes the first value: do not append it twice.
    var values = parameter.multiValue || [parameter];
    values.forEach(function (entry) {
      // Re-encoding would corrupt existing % escapes and change + semantics.
      parts.push(name + '=' + entry.value);
    });
  });

  return {
    statusCode: 308,
    statusDescription: 'Permanent Redirect',
    headers: {
      location: {
        value: 'https://www.niceworkshop.ca' + request.uri
          + (parts.length ? '?' + parts.join('&') : '')
      }
    }
  };
}
